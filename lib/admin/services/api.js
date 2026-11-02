"use strict";

/**
 * Service of the panel's API page (feature 004, specs/004-messaging-api/contracts/admin-api.md). It never touches
 * `req`/`res`: the route module hands it plain values (`at` in ms, the request's scheme and host, the step-up
 * callback) and writes the audit rows it returns.
 *
 *   const service = createApiService(deps);
 *   service.state(input)                     API-1   State (reads, writes nothing)
 *   service.setState(body, input)            API-2   switch and plain-HTTP networks   -> { answer, audits }
 *   service.catalog()                        API-3   rights, formats, endpoints, limits
 *   service.listKeys(input)                  API-4   { items: [KeyView] }
 *   service.createKey(body, input)           API-5   { key, secret, audits }
 *   service.updateKey(id, body, input)       API-6   { key, changed, audits }
 *   service.duplicateKey(id, body, input)    API-7   { key, secret, audits }
 *   service.revokeKey(id, body, input)       API-8   { key, cancelled, audits }
 *   service.listMessages(query)              API-9   { items: [MessageRow], page, pageSize, total }
 *   service.getMessage(id)                   API-10  { message: MessageDetail }
 *   service.testSend(body, input)            API-11  { message: MessageRow, audits }
 *   service.usage(query, input)              API-12  Usage
 *   service.openapi(input)                   API-13  the OpenAPI document
 *
 * `input` carries `at` (the request time in ms) and, where a route needs them, `https`, `host`, `confirmedUntil`,
 * `stepUp(reasons)` (throws `password_required`), `sessionId`, `requestId`, `signal`. `audits` is a list of
 * `{ action, target, detail }`, one per distinct action, empty when nothing changed (admin-api.md 1.7).
 *
 * Collaborators come from `deps` and are resolved where they are used, so a test injects a fake: `apiState`,
 * `messaging`, `api` (the public API object of lib/api: `state()`, `catalog()`, `openapi()`, `keys`), `keyStore`,
 * `ipRules`, `uploads`, `redactor`, `models`, `config`, `logger`, `trustProxy`.
 *
 * Security (rule 10): the key secret leaves this module once, in the return value of createKey/duplicateKey; it is
 * registered with the log redactor before the row is written, and it appears in no audit detail, no log line and no
 * other answer. `lookupId`, `secretHash` and `seenIps` are never part of a view; a message row carries no text, no
 * caption, no file name and no option label (FR-073). Every view is built from an explicit field list.
 *
 * Writes: keys under `withLock("api-keys")`, the switch under `withLock("api-state")` (apiState holds its own
 * `api-state:write` inside, never this key), `keyStore.invalidate(id)` after every commit (FR-014).
 */

const fs = require("fs");
const { Op } = require("sequelize");
const { DateTime, Info } = require("luxon");
const { AdminError } = require("../http/response");
const { withLock } = require("../../utils/mutex");
const { MessagingError, STATUSES } = require("../../messaging/errors");

// ---------------------------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------------------------

const BASE_PATH = "/api/v1";
const WINDOW_MS = 5 * 60 * 1000; // the step-up window (lib/admin/auth/sessions.js STEP_UP_MS)
const KEYS_MAX = 50;
const SECRET_TTL_MS = 10 * 60 * 1000;
const DETAIL_MAX = 1900; // audit.js caps a detail at 2000 characters; the "what" is degraded before it is lost
const NAME_MAX = 64;
const POLICY_MODES = ["list", "known", "anyone"];
const POLICY_RANK = Object.freeze({ list: 0, known: 1, anyone: 2 });
const REASONS = Object.freeze(["enable", "create", "rights", "policy", "ip", "expiry", "plain_http"]);
const INTERACTIVE_FALLBACK = new Set(["buttons", "list", "poll"]); // a removed format module still shows its answers
const IN_CHUNK = 400;

const LIMITS = Object.freeze({
  keyNameMax: NAME_MAX,
  rightsMax: 64,
  recipientsMax: 200,
  ipAllowMax: 50,
  plainHttpFromMax: 20,
  keysMax: KEYS_MAX,
  perMinute: Object.freeze([1, 1000]),
  perDay: Object.freeze([1, 100000]),
  maxPending: Object.freeze([1, 5000]),
});

const RIGHT_ID = /^[a-z]+(\.[a-z0-9_]+)*$/;
const NO_CONTROL = /^[^\p{Cc}]+$/u;
const PN_JID = /^[1-9]\d{7,14}@s\.whatsapp\.net$/;
const GROUP_JID = /^\d{5,25}(-\d+)?@g\.us$/;
const UPLOAD_ID = /^[0-9a-f]{32}$/;

/** Strict schema of KeyInput (admin-api.md 1.2); API-6 adds `version`, API-5 leaves it an unknown property. */
const KEY_INPUT = Object.freeze({
  name: { type: "string", required: true, trim: true, minLength: 1, maxLength: NAME_MAX, pattern: NO_CONTROL },
  rights: { type: "array", required: true, max: LIMITS.rightsMax, unique: true, items: { type: "string", trim: true, maxLength: 64, pattern: RIGHT_ID } },
  policy: {
    type: "object",
    required: true,
    shape: {
      mode: { type: "string", required: true, enum: POLICY_MODES },
      recipients: { type: "array", required: true, max: LIMITS.recipientsMax, items: { type: "string", trim: true, maxLength: 64 } },
    },
  },
  limits: {
    type: "object",
    required: true,
    shape: {
      perMinute: { type: "int", nullable: true, min: LIMITS.perMinute[0], max: LIMITS.perMinute[1] },
      perDay: { type: "int", nullable: true, min: LIMITS.perDay[0], max: LIMITS.perDay[1] },
      maxPending: { type: "int", nullable: true, min: LIMITS.maxPending[0], max: LIMITS.maxPending[1] },
    },
  },
  ipAllow: { type: "array", required: true, max: LIMITS.ipAllowMax, items: { type: "string", trim: true, maxLength: 64 } },
  expiresAt: { type: "string", required: true, nullable: true, maxLength: 40 },
  confirm: { type: "array", max: 4, items: { type: "string", enum: ["policy_anyone"] } },
});
const KEY_UPDATE = Object.freeze({ ...KEY_INPUT, version: { type: "int", required: true, min: 1, max: 2147483647 } });
const KEY_DUPLICATE = Object.freeze({ name: { ...KEY_INPUT.name, required: false } });
const KEY_REVOKE = Object.freeze({ confirm: { type: "boolean" } });
const STATE_INPUT = Object.freeze({
  enabled: { type: "boolean", required: true },
  plainHttpFrom: { type: "array", max: LIMITS.plainHttpFromMax, items: { type: "string", trim: true, maxLength: 64 } },
  confirm: { type: "boolean" },
});

const MESSAGES_QUERY = Object.freeze({
  key: { type: "string", pattern: /^(panel|[1-9]\d{0,9})$/ },
  status: { type: "string", enum: STATUSES },
  format: { type: "string", pattern: /^[a-z][a-z0-9_]{0,23}$/ },
  from: { type: "string", maxLength: 40 },
  to: { type: "string", maxLength: 40 },
  page: { type: "string", pattern: /^\d{1,6}$/ },
  pageSize: { type: "string", pattern: /^\d{1,3}$/ },
});
const USAGE_QUERY = Object.freeze({
  days: { type: "string", enum: ["7", "30"] },
  key: { type: "string", pattern: /^(all|panel|[1-9]\d{0,9})$/ },
});

const SETTING_KEYS = Object.freeze({
  minSpacingMs: "SEND_MIN_SPACING_MS",
  perMinute: "API_RATE_PER_MINUTE",
  perDay: "API_RATE_PER_DAY",
  maxPending: "API_MAX_PENDING",
  queueMax: "API_QUEUE_MAX",
  expiryMin: "API_QUEUE_EXPIRY_MIN",
  retentionDays: "API_RETENTION_DAYS",
  replyWindowDays: "API_REPLY_WINDOW_DAYS",
  alerts: Object.freeze({
    originBlocked: "ALERT_API_ORIGIN_BLOCKED",
    keyNewIp: "ALERT_API_KEY_NEW_IP",
    paused: "ALERT_API_PAUSED",
  }),
});

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------------

const iso = (value) => {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};
const msOf = (value) => (value === null || value === undefined ? null : new Date(value).getTime());

/** A JSON column as a list (SQLite may hand a string back, a damaged value is empty) */
function asList(value) {
  let list = value;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      return [];
    }
  }
  return Array.isArray(list) ? list : [];
}

const sameSet = (a, b) => {
  const left = new Set(a);
  return left.size === new Set(b).size && b.every((item) => left.has(item));
};

/** ISO-8601 with `Z` or an offset -> ms, or null. luxon refuses an impossible calendar date (February 31). */
function parseIso(text) {
  if (typeof text !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(text)) return null;
  const parsed = DateTime.fromISO(text, { setZone: true });
  return parsed.isValid ? parsed.toMillis() : null;
}

/** "active" | "expired" | "revoked", first match (data-model.md 1.4) */
function statusOf(row, at) {
  if (row.revokedAt) return "revoked";
  if (row.expiresAt && new Date(row.expiresAt).getTime() <= at) return "expired";
  return "active";
}

/**
 * The reasons for which a change asks for the password again (admin-api.md 1.5), in the fixed order of REASONS.
 * `before === null` is a creation. A key is `{ rights, policy: { mode, recipients: [jid] }, ipAllow, expiresAt }`,
 * the state `{ enabled, plainHttpFrom }`; only the properties present in `after` are compared. Pinned row by row by
 * test/fixtures/api-widenings.json, which the SPA's pure mirror (views/api-logic.mjs) also loads.
 * @param {object|null} before the stored value
 * @param {object} after the normalised submitted value
 * @param {{ covers: Function }} [ipRules] the IP grammar (default: lib/api/ipRules.js)
 */
function widenings(before, after, ipRules = require("../../api/ipRules")) {
  if (before === null || before === undefined) return ["create"];
  const next = after || {};
  const reasons = new Set();

  if (next.enabled === true && before.enabled === false) reasons.add("enable");

  if (Array.isArray(next.rights)) {
    const had = new Set(asList(before.rights));
    if (next.rights.some((id) => !had.has(id))) reasons.add("rights");
  }

  if (next.policy && typeof next.policy === "object") {
    const was = before.policy || {};
    const rank = (mode) => (Object.hasOwn(POLICY_RANK, mode) ? POLICY_RANK[mode] : 0);
    const raised = next.policy.mode !== undefined && rank(next.policy.mode) > rank(was.mode);
    // whatever the mode: a recipient stored while the mode ignores it would otherwise activate later without a prompt
    const hadJids = new Set(asList(was.recipients));
    const added = Array.isArray(next.policy.recipients) && next.policy.recipients.some((jid) => !hadJids.has(jid));
    if (raised || added) reasons.add("policy");
  }

  if (Array.isArray(next.ipAllow)) {
    const old = asList(before.ipAllow);
    if (old.length && (next.ipAllow.length === 0 || next.ipAllow.some((entry) => !ipRules.covers(old, entry)))) reasons.add("ip");
  }

  if (next.expiresAt !== undefined && before.expiresAt) {
    const was = Date.parse(before.expiresAt);
    const will = next.expiresAt === null ? null : Date.parse(next.expiresAt);
    // an unreadable instant counts as later: this predicate fails closed
    if (will === null || Number.isNaN(will) || Number.isNaN(was) || will > was) reasons.add("expiry");
  }

  if (Array.isArray(next.plainHttpFrom)) {
    const old = asList(before.plainHttpFrom);
    if (next.plainHttpFrom.some((entry) => !ipRules.covers(old, entry))) reasons.add("plain_http");
  }

  return REASONS.filter((reason) => reasons.has(reason));
}

/** The audit detail within DETAIL_MAX: `rightsRemoved` then `rightsAdded` become counts before the "what" is lost */
function fitDetail(detail) {
  const out = { ...detail };
  const size = () => JSON.stringify(out).length;
  if (size() > DETAIL_MAX && Array.isArray(out.rightsRemoved)) {
    out.rightsRemovedCount = out.rightsRemoved.length;
    delete out.rightsRemoved;
  }
  if (size() > DETAIL_MAX && Array.isArray(out.rightsAdded)) {
    out.rightsAddedCount = out.rightsAdded.length;
    delete out.rightsAdded;
  }
  return out;
}

/** Parse one typed recipient: a number, a `<digits>@s.whatsapp.net` JID or a group id; the code of a failure. */
function parseRecipientEntry(text, parsePhoneNumber) {
  const raw = String(text).trim();
  if (raw.includes("@")) {
    return PN_JID.test(raw) || GROUP_JID.test(raw) ? { jid: raw } : { code: "invalid_jid" }; // a LID is never an entry
  }
  const parsed = parsePhoneNumber(raw);
  return parsed && parsed.pn ? { jid: parsed.pn } : { code: "invalid_phone" };
}

function validationFailed(fields) {
  return new AdminError("validation_failed", { fields });
}

const notFound = (resource) => new AdminError("not_found", { params: { resource } });

/** Unique violation of a Sequelize write (SQLite and Postgres) */
const isUniqueViolation = (err) =>
  Boolean(err) && (err.name === "SequelizeUniqueConstraintError" || (err.parent && (err.parent.code === "23505" || /UNIQUE/.test(String(err.parent.code)))));

// ---------------------------------------------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------------------------------------------

function createApiService(deps = {}) {
  const getModels = () => deps.models || require("../../database");
  const getApiState = () => deps.apiState || require("../../utils/apiState");
  const getMessaging = () => deps.messaging || require("../../messaging");
  const getIpRules = () => deps.ipRules || require("../../api/ipRules");
  const getRedactor = () => deps.redactor || require("../logs/redactor");
  const getApi = () => deps.api || null;
  const getKeyStore = () => deps.keyStore || (getApi() && getApi().keys) || null;
  const getUploads = () => deps.uploads || null;
  const getLogger = () => deps.logger || require("../../utils/logger").createLogger("admin-api");

  /** A setting: the injected config object first (tests), then the real one */
  const setting = (key) => {
    const local = deps.config;
    if (local && local[key] !== undefined && local[key] !== null) return local[key];
    return require("../../../config")[key];
  };

  const safeLog = (err) => {
    try {
      return require("../../utils/http").safeLog(err);
    } catch {
      return { name: err && err.name };
    }
  };

  // ---- the registries ---------------------------------------------------------------------------------------

  /** `null` when the registry is healthy, else `{ code: "registry_failed", endpoint }` (the reason text stays in the log) */
  function failure() {
    const api = getApi();
    if (!api) return { code: "registry_failed", endpoint: null };
    const state = api.state();
    return state && state.failure ? { code: "registry_failed", endpoint: state.failure.endpoint || null } : null;
  }

  /** Right ids of the catalogue; empty while the registry failed (nothing new can be granted) */
  function catalogRights() {
    const api = getApi();
    if (!api || failure()) return [];
    return api.rights().map((row) => row.id);
  }

  // ---- State (API-1) -----------------------------------------------------------------------------------------

  function baseUrlOf({ https, host }) {
    const configured = String(setting("PANEL_PUBLIC_URL") || "").trim();
    if (configured) {
      try {
        const origin = new URL(configured).origin;
        if (origin && origin !== "null") return `${origin}${BASE_PATH}`;
      } catch {
        // a malformed PANEL_PUBLIC_URL: the request's own origin is the better answer
      }
    }
    const safeHost = typeof host === "string" && /^[A-Za-z0-9.\-[\]:]{1,255}$/.test(host) ? host : "localhost";
    return `${https ? "https" : "http"}://${safeHost}${BASE_PATH}`;
  }

  const originOf = (input) => baseUrlOf(input).slice(0, -BASE_PATH.length);

  function settingsView() {
    const n = (key) => Number(setting(key));
    return {
      minSpacingMs: n("SEND_MIN_SPACING_MS"),
      perMinute: n("API_RATE_PER_MINUTE"),
      perDay: n("API_RATE_PER_DAY"),
      maxPending: n("API_MAX_PENDING"),
      queueMax: n("API_QUEUE_MAX"),
      expiryMin: n("API_QUEUE_EXPIRY_MIN"),
      retentionDays: n("API_RETENTION_DAYS"),
      replyWindowDays: n("API_REPLY_WINDOW_DAYS"),
      alerts: {
        originBlocked: setting("ALERT_API_ORIGIN_BLOCKED") !== false,
        keyNewIp: setting("ALERT_API_KEY_NEW_IP") === true,
        paused: setting("ALERT_API_PAUSED") !== false,
      },
      settingKeys: { ...SETTING_KEYS, alerts: { ...SETTING_KEYS.alerts } },
    };
  }

  async function state(input = {}) {
    const at = input.at ?? Date.now();
    const current = getApiState().get();
    const stats = await getMessaging().stats();
    const rows = await getModels().ApiKey.findAll({ attributes: ["revokedAt", "expiresAt"] });
    const counts = { active: 0, expired: 0, revoked: 0 };
    for (const row of rows) counts[statusOf(row, at)] += 1;
    return {
      enabled: current.enabled === true,
      changedAt: iso(current.updatedAt),
      failure: failure(),
      queued: Number(stats.queued) || 0,
      pausedUntil: stats.pausedUntil ? iso(stats.pausedUntil) : null,
      botReady: stats.botReady === true,
      https: input.https === true,
      baseUrl: baseUrlOf(input),
      plainHttpFrom: [...current.plainHttpFrom],
      stepUp: { confirmedUntil: input.confirmedUntil ? iso(input.confirmedUntil) : null, windowMs: WINDOW_MS },
      counts,
      settings: settingsView(),
    };
  }

  // ---- The switch and the plain-HTTP networks (API-2) ---------------------------------------------------------

  /** Entries of `plainHttpFrom` -> canonical list, or a 422 with the indices of the first kind of fault */
  function normaliseNetworks(list) {
    const rules = getIpRules();
    const parsed = rules.parse(list, { privateOnly: true, max: LIMITS.plainHttpFromMax });
    const syntax = parsed.invalid.filter((item) => !item.reason).map((item) => item.index);
    if (syntax.length) throw validationFailed({ plainHttpFrom: { code: "invalid_format", params: { indices: syntax } } });
    const outside = parsed.invalid.filter((item) => item.reason === "not_private").map((item) => item.index);
    if (outside.length) throw validationFailed({ plainHttpFrom: { code: "invalid_format", params: { indices: outside, reason: "not_private" } } });
    if (parsed.tooMany) throw validationFailed({ plainHttpFrom: { code: "too_many_items", params: { max: LIMITS.plainHttpFromMax } } });
    return parsed.entries;
  }

  async function setState(body, input = {}) {
    const at = input.at ?? Date.now();
    const apiState = getApiState();
    const wanted = body.plainHttpFrom !== undefined ? normaliseNetworks(body.plainHttpFrom) : undefined;

    if (body.enabled === true && failure()) {
      const f = failure();
      throw new AdminError("api_disabled", { params: { reason: "registry_failed", ...(f.endpoint ? { endpoint: f.endpoint } : {}) } });
    }
    if (body.enabled === false && apiState.get().enabled === true && body.confirm !== true) {
      throw new AdminError("confirmation_required", { params: { confirm: "disable_api" } });
    }

    return withLock("api-state", async () => {
      const current = apiState.get();
      const before = { enabled: current.enabled === true, plainHttpFrom: [...current.plainHttpFrom] };
      const after = { enabled: body.enabled, plainHttpFrom: wanted !== undefined ? wanted : before.plainHttpFrom };
      const enabledChanged = before.enabled !== after.enabled;
      const listChanged = !sameSet(before.plainHttpFrom, after.plainHttpFrom);

      if (!enabledChanged && !listChanged) {
        return { answer: { enabled: before.enabled, plainHttpFrom: before.plainHttpFrom, changed: false, cancelled: 0 }, audits: [] };
      }

      const reasons = widenings(before, after, getIpRules());
      if (reasons.length) input.stepUp(reasons);

      const change = {};
      if (enabledChanged) change.enabled = after.enabled;
      if (listChanged) change.plainHttpFrom = after.plainHttpFrom;

      // Disabling cancels the queue first so the answer can say how many messages it cost (the engine's own listener
      // of apiState finds nothing left to cancel). A write that then fails restarts the engine: the switch is still on.
      let cancelled = 0;
      const disabling = enabledChanged && after.enabled === false;
      const messaging = getMessaging();
      if (disabling) {
        const result = await messaging.disable({ reason: "api_disabled" });
        cancelled = Number(result && result.cancelled) || 0;
      }
      let written;
      try {
        written = await apiState.setState(change, { now: at });
      } catch (err) {
        if (disabling && typeof messaging.enable === "function") messaging.enable();
        if (err && err.code === "invalid_format") throw validationFailed({ plainHttpFrom: { code: "invalid_format", params: err.params || { indices: [] } } });
        throw err;
      }

      const audits = [];
      if (enabledChanged) audits.push(after.enabled ? { action: "api.enable", target: null, detail: {} } : { action: "api.disable", target: null, detail: { cancelled } });
      if (listChanged) {
        audits.push({
          action: "api.plainhttp.update",
          target: null,
          detail: {
            added: after.plainHttpFrom.filter((entry) => !before.plainHttpFrom.includes(entry)),
            removed: before.plainHttpFrom.filter((entry) => !after.plainHttpFrom.includes(entry)),
          },
        });
      }
      return { answer: { enabled: written.enabled, plainHttpFrom: written.plainHttpFrom, changed: true, cancelled }, audits };
    });
  }

  // ---- Catalog and OpenAPI (API-3, API-13) ----------------------------------------------------------------------

  function catalog() {
    const api = getApi();
    const failed = failure();
    const base = !api || failed ? { version: "v1", basePath: BASE_PATH, rights: [], formats: [], endpoints: [] } : api.catalog();
    return {
      version: base.version,
      basePath: base.basePath,
      rights: failed ? [] : base.rights,
      formats: failed ? [] : base.formats,
      endpoints: failed ? [] : base.endpoints,
      limits: { ...LIMITS, perMinute: [...LIMITS.perMinute], perDay: [...LIMITS.perDay], maxPending: [...LIMITS.maxPending] },
    };
  }

  function openapi(input = {}) {
    const failed = failure();
    if (failed) throw new AdminError("api_disabled", { params: { reason: "registry_failed", ...(failed.endpoint ? { endpoint: failed.endpoint } : {}) } });
    return getApi().openapi({ baseUrl: originOf(input) });
  }

  // ---- Keys: views ---------------------------------------------------------------------------------------------

  /** jid -> name (private push name, group subject) from KnownChat; a person recorded under a LID is found by `pnJid` */
  async function namesOf(jids) {
    const names = new Map();
    const unique = [...new Set(jids)];
    const { KnownChat } = getModels();
    if (!KnownChat) return names;
    for (let i = 0; i < unique.length; i += IN_CHUNK) {
      const chunk = unique.slice(i, i + IN_CHUNK);
      const rows = await KnownChat.findAll({
        where: { [Op.or]: [{ jid: { [Op.in]: chunk } }, { pnJid: { [Op.in]: chunk } }] },
        attributes: ["jid", "pnJid", "name"],
      });
      for (const row of rows) {
        if (!row.name) continue;
        for (const jid of [row.pnJid, row.jid]) if (jid && !names.has(jid)) names.set(jid, row.name);
      }
    }
    return names;
  }

  /** apiKeyId -> number of `queued` messages */
  async function queuedByKey() {
    const { ApiMessage } = getModels();
    const rows = await ApiMessage.findAll({
      attributes: ["apiKeyId", [ApiMessage.sequelize.fn("COUNT", ApiMessage.sequelize.col("id")), "n"]],
      where: { status: "queued", apiKeyId: { [Op.ne]: null } },
      group: ["apiKeyId"],
      raw: true,
    });
    return new Map(rows.map((row) => [Number(row.apiKeyId), Number(row.n)]));
  }

  /** KeyView: explicit field list, no hash, no lookup id, no `seenIps` (only its length) */
  function keyView(row, { at, catalogIds, hasCatalog, names, queued }) {
    const rights = [...asList(row.rights)].sort();
    const known = new Set(catalogIds);
    const recipients = asList(row.recipients);
    return {
      id: row.id,
      name: row.name,
      last4: row.last4,
      status: statusOf(row, at),
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
      revokedAt: iso(row.revokedAt),
      expiresAt: iso(row.expiresAt),
      version: row.version,
      lastUsedAt: iso(row.lastUsedAt),
      lastUsedIp: row.lastIp || null,
      seenIpCount: asList(row.seenIps).length,
      rights,
      // while the registry failed the catalogue is empty and says nothing about a removed module
      orphanRights: hasCatalog ? rights.filter((id) => !known.has(id)) : [],
      policy: { mode: row.policyMode, recipients: recipients.map((jid) => ({ jid, name: names.get(jid) || null })) },
      limits: { perMinute: row.limitPerMinute ?? null, perDay: row.limitPerDay ?? null, maxPending: row.limitPending ?? null },
      ipAllow: asList(row.ipAllow),
      queued: queued.get(row.id) || 0,
    };
  }

  async function viewsOf(rows, at) {
    const catalogIds = catalogRights();
    const names = await namesOf(rows.flatMap((row) => asList(row.recipients)));
    const queued = await queuedByKey();
    const hasCatalog = getApi() !== null && !failure();
    return rows.map((row) => keyView(row, { at, catalogIds, hasCatalog, names, queued }));
  }

  async function viewOfKey(id, at) {
    const row = await getModels().ApiKey.findByPk(id);
    return (await viewsOf([row], at))[0];
  }

  async function listKeys(input = {}) {
    const at = input.at ?? Date.now();
    const rows = await getModels().ApiKey.findAll({ order: [["id", "ASC"]] });
    const live = rows.filter((row) => !row.revokedAt);
    const revoked = rows.filter((row) => row.revokedAt).sort((a, b) => new Date(b.revokedAt) - new Date(a.revokedAt) || b.id - a.id);
    return { items: await viewsOf([...live, ...revoked], at) };
  }

  // ---- Keys: input semantics -------------------------------------------------------------------------------------

  /**
   * The checks that need no stored data beyond the key itself: rights against the catalogue (and what the key already
   * holds), recipients, IP entries, expiry. All faults at once. Returns the normalised value.
   */
  function normaliseInput(body, { stored = null, at, create }) {
    const fields = {};
    const { parsePhoneNumber } = require("../../utils/permissions");
    const rules = getIpRules();

    const allowed = catalogRights();
    const known = new Set(allowed);
    const had = new Set(stored ? asList(stored.rights) : []);
    const badRights = [];
    body.rights.forEach((id, index) => {
      if (!known.has(id) && !had.has(id)) badRights.push(index);
    });
    if (badRights.length) fields.rights = { code: "not_allowed", params: { allowed, indices: badRights } };
    const rights = [...new Set(body.rights)].sort();

    const failures = [];
    const jids = [];
    body.policy.recipients.forEach((entry, index) => {
      const parsed = parseRecipientEntry(entry, parsePhoneNumber);
      if (parsed.code) failures.push({ index, code: parsed.code });
      else if (!jids.includes(parsed.jid)) jids.push(parsed.jid);
    });
    if (failures.length) {
      const code = failures[0].code;
      fields["policy.recipients"] = { code, params: { indices: failures.filter((f) => f.code === code).map((f) => f.index) } };
    }

    const ips = rules.parse(body.ipAllow, { max: LIMITS.ipAllowMax });
    if (ips.invalid.length) fields.ipAllow = { code: "invalid_format", params: { indices: ips.invalid.map((item) => item.index) } };

    let expiresAt = null;
    if (body.expiresAt !== null && body.expiresAt !== undefined) {
      const ms = parseIso(body.expiresAt);
      if (ms === null) {
        fields.expiresAt = { code: "invalid_format" };
      } else {
        // editing an already expired key without touching its date is not an error
        const storedMs = stored ? msOf(stored.expiresAt) : null;
        if ((create || storedMs === null || ms !== storedMs) && ms <= at) fields.expiresAt = { code: "in_past" };
        expiresAt = new Date(ms);
      }
    }

    if (Object.keys(fields).length) throw validationFailed(fields);
    const limits = body.limits || {};
    return {
      name: body.name,
      rights,
      mode: body.policy.mode,
      recipients: jids,
      limits: { perMinute: limits.perMinute ?? null, perDay: limits.perDay ?? null, maxPending: limits.maxPending ?? null },
      ipAllow: ips.entries,
      expiresAt,
    };
  }

  /** The columns a value writes (configuration only: never a usage column, the hash or the lookup id) */
  const columnsOf = (value) => ({
    name: value.name,
    nameKey: value.name.toLowerCase(),
    rights: value.rights,
    policyMode: value.mode,
    recipients: value.recipients,
    limitPerMinute: value.limits.perMinute,
    limitPerDay: value.limits.perDay,
    limitPending: value.limits.maxPending,
    ipAllow: value.ipAllow,
    expiresAt: value.expiresAt,
  });

  /** The shape `widenings` compares, from a stored row and from a normalised value */
  const storedShape = (row) => ({
    rights: asList(row.rights),
    policy: { mode: row.policyMode, recipients: asList(row.recipients) },
    ipAllow: asList(row.ipAllow),
    expiresAt: iso(row.expiresAt),
  });
  const valueShape = (value) => ({
    rights: value.rights,
    policy: { mode: value.mode, recipients: value.recipients },
    ipAllow: value.ipAllow,
    expiresAt: iso(value.expiresAt),
  });

  /** Field names of KeyInput that differ between a stored row and a value (admin-api.md 1.7 `changed`) */
  function changedFields(row, value) {
    const changed = [];
    if (row.name !== value.name) changed.push("name");
    if (!sameSet(asList(row.rights), value.rights)) changed.push("rights");
    if (row.policyMode !== value.mode) changed.push("policy");
    if (!sameSet(asList(row.recipients), value.recipients)) changed.push("recipients");
    if ((row.limitPerMinute ?? null) !== value.limits.perMinute || (row.limitPerDay ?? null) !== value.limits.perDay || (row.limitPending ?? null) !== value.limits.maxPending) changed.push("limits");
    if (!sameSet(asList(row.ipAllow), value.ipAllow)) changed.push("ipAllow");
    if (msOf(row.expiresAt) !== msOf(value.expiresAt)) changed.push("expiresAt");
    return changed;
  }

  /** `changed` of a new key: what differs from an empty key */
  const createdFields = (value) => {
    const changed = ["name"];
    if (value.rights.length) changed.push("rights");
    if (value.mode !== "list") changed.push("policy");
    if (value.recipients.length) changed.push("recipients");
    if (value.limits.perMinute !== null || value.limits.perDay !== null || value.limits.maxPending !== null) changed.push("limits");
    if (value.ipAllow.length) changed.push("ipAllow");
    if (value.expiresAt) changed.push("expiresAt");
    return changed;
  };

  const needsAnyone = (value, confirm) => value.mode === "anyone" && !(Array.isArray(confirm) && confirm.includes("policy_anyone"));
  const anyoneRequired = () => new AdminError("confirmation_required", { params: { confirm: ["policy_anyone"] } });

  /** The live key (not revoked) that holds this name, any case, excluding one id */
  async function nameTaken(name, exceptId = null) {
    const row = await getModels().ApiKey.findOne({ where: { nameKey: name.toLowerCase() }, attributes: ["id"] });
    return Boolean(row) && row.id !== exceptId;
  }

  const duplicateName = () => validationFailed({ name: { code: "duplicate" } });

  async function liveKeyCount() {
    return getModels().ApiKey.count({ where: { revokedAt: null } });
  }

  /** Generate a secret, register it with the log redactor, write the row. A lookup id collision retries. */
  async function insertKey(value, { extra = {} } = {}) {
    const keyStore = getKeyStore();
    const { ApiKey } = getModels();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const generated = keyStore.generateSecret();
      // before the write: an error log of this very request is already scrubbed (the built-in pattern is the 2nd line)
      getRedactor().registerEphemeral(`apikey:${generated.lookupId}`, generated.secret, SECRET_TTL_MS);
      try {
        const row = await ApiKey.create({
          ...columnsOf(value),
          lookupId: generated.lookupId,
          secretHash: generated.secretHash,
          last4: generated.last4,
          version: 1,
          ...extra,
        });
        return { row, secret: generated.secret };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        const fields = (err.fields && Object.keys(err.fields)) || [];
        if (fields.includes("nameKey") || /name_key|nameKey/.test(String(err.parent && err.parent.message))) throw duplicateName();
      }
    }
    throw new Error("api key: no free lookup id after 3 attempts");
  }

  // ---- Keys: API-5, API-6, API-7, API-8 ------------------------------------------------------------------------

  async function createKey(body, input = {}) {
    const at = input.at ?? Date.now();
    const value = normaliseInput(body, { at, create: true });
    return withLock("api-keys", async () => {
      if ((await liveKeyCount()) >= KEYS_MAX) throw new AdminError("limit_reached", { params: { max: KEYS_MAX } });
      if (await nameTaken(value.name)) throw duplicateName();
      if (needsAnyone(value, body.confirm)) throw anyoneRequired();
      const { row, secret } = await insertKey(value);
      getKeyStore().invalidate(row.id);
      return {
        key: await viewOfKey(row.id, at),
        secret,
        audits: [
          {
            action: "api.key.create",
            target: String(row.id),
            detail: fitDetail({ name: row.name, last4: row.last4, rightsAdded: value.rights, policyTo: value.mode, changed: createdFields(value) }),
          },
        ],
      };
    });
  }

  async function updateKey(id, body, input = {}) {
    const at = input.at ?? Date.now();
    const { ApiKey } = getModels();
    return withLock("api-keys", async () => {
      const row = await ApiKey.findByPk(id);
      if (!row) throw notFound("key");
      if (row.revokedAt) throw new AdminError("not_editable"); // an expired key IS editable: its expiry can be extended

      const value = normaliseInput(body, { stored: row, at, create: false });
      if (await nameTaken(value.name, row.id)) throw duplicateName();
      if (body.version !== row.version) {
        throw new AdminError("conflict", { fields: { version: { code: "conflict", params: { version: row.version } } } });
      }
      if (value.mode === "anyone" && row.policyMode !== "anyone" && needsAnyone(value, body.confirm)) throw anyoneRequired();

      const changed = changedFields(row, value);
      if (!changed.length) return { key: await viewOfKey(row.id, at), changed: false, audits: [] };

      const reasons = widenings(storedShape(row), valueShape(value), getIpRules());
      if (reasons.length) input.stepUp(reasons); // last: a wrong password or a missing confirmation saves nothing

      const [count] = await ApiKey.update(
        { ...columnsOf(value), version: row.version + 1 },
        { where: { id: row.id, version: row.version, revokedAt: null } },
      );
      if (count === 0) {
        const now = await ApiKey.findByPk(id);
        if (!now) throw notFound("key");
        if (now.revokedAt) throw new AdminError("not_editable");
        throw new AdminError("conflict", { fields: { version: { code: "conflict", params: { version: now.version } } } });
      }
      getKeyStore().invalidate(row.id);

      const before = new Set(asList(row.rights));
      const after = new Set(value.rights);
      const detail = {
        name: value.name,
        last4: row.last4,
        rightsAdded: value.rights.filter((right) => !before.has(right)),
        rightsRemoved: [...before].filter((right) => !after.has(right)).sort(),
        changed,
      };
      if (row.policyMode !== value.mode) {
        detail.policyFrom = row.policyMode;
        detail.policyTo = value.mode;
      }
      if (reasons.length) detail.widened = reasons;
      return {
        key: await viewOfKey(row.id, at),
        changed: true,
        audits: [{ action: "api.key.update", target: String(row.id), detail: fitDetail(detail) }],
      };
    });
  }

  /** `<name> (n)` with the first free n >= 2, the base cut so the whole stays within 64 code points */
  async function suggestedName(source) {
    const base = Array.from(source);
    for (let n = 2; n < 1000; n += 1) {
      const suffix = ` (${n})`;
      const head = base.slice(0, NAME_MAX - suffix.length).join("").trimEnd();
      const candidate = `${head}${suffix}`;
      if (!(await nameTaken(candidate))) return candidate;
    }
    throw new AdminError("limit_reached", { params: { max: KEYS_MAX } });
  }

  async function duplicateKey(id, body, input = {}) {
    const at = input.at ?? Date.now();
    const { ApiKey } = getModels();
    return withLock("api-keys", async () => {
      const source = await ApiKey.findByPk(id);
      if (!source) throw notFound("key");
      if (statusOf(source, at) !== "active") throw new AdminError("not_editable"); // the copy of an expired key would be born expired

      let name;
      if (body.name !== undefined) {
        name = body.name;
        if (await nameTaken(name)) throw duplicateName();
      }
      if ((await liveKeyCount()) >= KEYS_MAX) throw new AdminError("limit_reached", { params: { max: KEYS_MAX } });
      if (name === undefined) name = await suggestedName(source.name);

      const known = new Set(catalogRights());
      const hasCatalog = getApi() !== null && !failure();
      const rights = asList(source.rights).filter((right) => !hasCatalog || known.has(right)); // orphan rights are dropped
      const value = {
        name,
        rights: [...rights].sort(),
        mode: source.policyMode,
        recipients: asList(source.recipients),
        limits: { perMinute: source.limitPerMinute ?? null, perDay: source.limitPerDay ?? null, maxPending: source.limitPending ?? null },
        ipAllow: asList(source.ipAllow),
        expiresAt: source.expiresAt ? new Date(source.expiresAt) : null,
      };
      const { row, secret } = await insertKey(value);
      getKeyStore().invalidate(row.id);
      return {
        key: await viewOfKey(row.id, at),
        secret,
        audits: [
          {
            action: "api.key.duplicate",
            target: String(row.id),
            detail: fitDetail({
              name: row.name,
              last4: row.last4,
              rightsAdded: value.rights,
              policyTo: value.mode,
              changed: createdFields(value),
              source: source.id,
            }),
          },
        ],
      };
    });
  }

  async function revokeKey(id, body, input = {}) {
    const at = input.at ?? Date.now();
    const { ApiKey } = getModels();
    if (body.confirm !== true) throw new AdminError("confirmation_required", { params: { confirm: "revoke_key" } });

    const done = await withLock("api-keys", async () => {
      const row = await ApiKey.findByPk(id);
      if (!row) throw notFound("key");
      if (row.revokedAt) return { row, already: true };
      // one statement clears the name reservation and sets the revocation
      const [count] = await ApiKey.update(
        { revokedAt: new Date(at), nameKey: null, version: row.version + 1 },
        { where: { id: row.id, revokedAt: null } },
      );
      if (count === 0) return { row, already: true }; // revoked meanwhile
      getKeyStore().invalidate(row.id);
      return { row, already: false };
    });
    if (done.already) return { key: await viewOfKey(id, at), cancelled: 0, audits: [] };

    // The revoke is committed and never rolled back; the claim-time guard of the engine cancels what a failure leaves.
    let cancelled = null;
    try {
      cancelled = Number(await getMessaging().cancelForKey(id, "key_revoked")) || 0;
    } catch (err) {
      getLogger().warn({ err: safeLog(err), keyId: id }, "api key revoked, its queued messages could not be cancelled");
    }
    return {
      key: await viewOfKey(id, at),
      cancelled,
      audits: [{ action: "api.key.revoke", target: String(id), detail: { name: done.row.name, last4: done.row.last4, cancelled } }],
    };
  }

  // ---- History and detail (API-9, API-10) ---------------------------------------------------------------------

  const MESSAGE_COLUMNS = ["id", "publicId", "apiKeyId", "source", "recipient", "format", "size", "status", "errorCode", "acceptedAt"];

  function messageRows(rows, { keyNames, chatNames }) {
    return rows.map((row) => ({
      id: row.id,
      source: row.source,
      key: row.source === "panel" || row.apiKeyId === null || row.apiKeyId === undefined ? null : { id: row.apiKeyId, name: keyNames.get(row.apiKeyId) || null },
      to: row.recipient,
      toName: chatNames.get(row.recipient) || null,
      kind: String(row.recipient).endsWith("@g.us") ? "group" : "private",
      format: row.format,
      size: row.size ?? null,
      status: row.status,
      failureCode: row.errorCode || null,
      acceptedAt: iso(row.acceptedAt),
    }));
  }

  async function presentRows(rows) {
    const { ApiKey } = getModels();
    const ids = [...new Set(rows.filter((row) => row.apiKeyId !== null && row.apiKeyId !== undefined).map((row) => row.apiKeyId))];
    const keyNames = new Map();
    if (ids.length) {
      for (const key of await ApiKey.findAll({ where: { id: { [Op.in]: ids } }, attributes: ["id", "name"] })) keyNames.set(key.id, key.name);
    }
    const chatNames = await namesOf(rows.map((row) => row.recipient));
    return messageRows(rows, { keyNames, chatNames });
  }

  function rangeFault(query) {
    const fields = {};
    const bounds = {};
    for (const name of ["from", "to"]) {
      if (query[name] === undefined) continue;
      const ms = parseIso(query[name]);
      if (ms === null) fields[name] = { code: "invalid_format" };
      else bounds[name] = new Date(ms);
    }
    if (Object.keys(fields).length) throw validationFailed(fields);
    return bounds;
  }

  async function listMessages(query = {}) {
    const { ApiMessage } = getModels();
    const page = query.page === undefined ? 1 : Number(query.page);
    const pageSize = query.pageSize === undefined ? 50 : Number(query.pageSize);
    const fields = {};
    if (!(page >= 1)) fields.page = { code: "out_of_range", params: { min: 1 } };
    if (!(pageSize >= 1 && pageSize <= 200)) fields.pageSize = { code: "out_of_range", params: { min: 1, max: 200 } };
    if (Object.keys(fields).length) throw validationFailed(fields);
    const bounds = rangeFault(query);

    const where = {};
    if (query.key === "panel") where.source = "panel";
    else if (query.key !== undefined) where.apiKeyId = Number(query.key);
    if (query.status !== undefined) where.status = query.status;
    if (query.format !== undefined) where.format = query.format;
    if (bounds.from || bounds.to) {
      where.acceptedAt = {};
      if (bounds.from) where.acceptedAt[Op.gte] = bounds.from;
      if (bounds.to) where.acceptedAt[Op.lte] = bounds.to;
    }

    const { rows, count } = await ApiMessage.findAndCountAll({
      where,
      attributes: MESSAGE_COLUMNS,
      order: [
        ["acceptedAt", "DESC"],
        ["id", "DESC"],
      ],
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    return { items: await presentRows(rows), page, pageSize, total: count };
  }

  /** The timestamp columns as steps, ascending by time; ties keep the lifecycle order, the terminal step last */
  function stepsOf(row) {
    const steps = [{ status: "queued", at: row.acceptedAt }];
    for (const [status, column] of [["sending", "sendingAt"], ["sent", "sentAt"], ["delivered", "deliveredAt"], ["read", "readAt"]]) {
      if (row[column]) steps.push({ status, at: row[column] });
    }
    if (["failed", "expired", "cancelled", "unknown"].includes(row.status) && row.endedAt) steps.push({ status: row.status, at: row.endedAt });
    return steps
      .map((step, index) => ({ ...step, index, ms: new Date(step.at).getTime() }))
      .sort((a, b) => a.ms - b.ms || a.index - b.index)
      .map((step) => ({ status: step.status, at: iso(step.at) }));
  }

  async function getMessage(id) {
    const { ApiMessage, ApiMessageResponse } = getModels();
    const row = await ApiMessage.findByPk(id, {
      attributes: [...MESSAGE_COLUMNS, "waId", "expiresAt", "sendingAt", "sentAt", "deliveredAt", "readAt", "endedAt", "repliesUntil", "choices"],
    });
    if (!row) throw notFound("message");
    const [base] = await presentRows([row]);

    const messaging = getMessaging();
    const module_ = messaging.formats && typeof messaging.formats.get === "function" ? messaging.formats.get(row.format) : null;
    const interactive = module_ ? module_.interactive === true : INTERACTIVE_FALLBACK.has(row.format);
    let responses = null;
    if (interactive) {
      const answers = await ApiMessageResponse.findAll({
        where: { messageId: row.id },
        order: [
          ["respondedAt", "ASC"],
          ["id", "ASC"],
        ],
      });
      responses = await messaging.describeResponses(row, answers);
    }
    return {
      message: {
        ...base,
        publicId: row.publicId,
        waId: row.waId || null,
        expiresAt: iso(row.expiresAt),
        steps: stepsOf(row),
        interactive,
        responses: responses === undefined ? null : responses,
      },
    };
  }

  // ---- Usage (API-12) -------------------------------------------------------------------------------------------

  const SENT = new Set(["sent", "delivered", "read"]);
  const FAILED = new Set(["failed", "expired", "unknown"]);

  async function usage(query = {}, input = {}) {
    const at = input.at ?? Date.now();
    const { ApiKey, ApiMessage } = getModels();
    const days = query.days === "30" ? 30 : 7;
    const selector = query.key === undefined ? "all" : query.key;
    const configured = String(setting("TIMEZONE") || "UTC");
    const zone = Info.isValidIANAZone(configured) ? configured : "UTC";

    const last = DateTime.fromMillis(at, { zone }).startOf("day");
    const labels = Array.from({ length: days }, (_, i) => last.minus({ days: days - 1 - i }).toFormat("yyyy-MM-dd"));

    let selectedKey = null;
    if (selector !== "all" && selector !== "panel") {
      selectedKey = await ApiKey.findByPk(Number(selector), { attributes: ["id", "name", "revokedAt"] });
      if (!selectedKey) throw notFound("key");
    }

    const where = { acceptedAt: { [Op.gte]: last.minus({ days: days - 1 }).toJSDate() }, status: { [Op.in]: [...SENT, ...FAILED] } };
    if (selector === "panel") where.source = "panel";
    else if (selectedKey) where.apiKeyId = selectedKey.id;
    const rows = await ApiMessage.findAll({ attributes: ["apiKeyId", "source", "status", "acceptedAt"], where, raw: true });

    // bucket by (entry, local day)
    const buckets = new Map(); // "key:<id>" | "panel" -> Map(day -> { sent, failed })
    for (const row of rows) {
      const entry = row.source === "panel" || row.apiKeyId === null ? "panel" : `key:${row.apiKeyId}`;
      const day = DateTime.fromMillis(new Date(row.acceptedAt).getTime(), { zone }).toFormat("yyyy-MM-dd");
      if (!buckets.has(entry)) buckets.set(entry, new Map());
      const counts = buckets.get(entry);
      if (!counts.has(day)) counts.set(day, { sent: 0, failed: 0 });
      counts.get(day)[SENT.has(row.status) ? "sent" : "failed"] += 1;
    }
    const daysOf = (entry) => labels.map((day) => ({ day, ...((buckets.get(entry) || new Map()).get(day) || { sent: 0, failed: 0 }) }));

    const keys = [];
    if (selectedKey) {
      keys.push({ id: selectedKey.id, name: selectedKey.name, source: "api", revoked: Boolean(selectedKey.revokedAt), days: daysOf(`key:${selectedKey.id}`) });
    } else if (selector === "panel") {
      keys.push({ id: null, name: null, source: "panel", revoked: false, days: daysOf("panel") });
    } else {
      const all = await ApiKey.findAll({ attributes: ["id", "name", "revokedAt"], order: [["id", "ASC"]] });
      for (const key of all) {
        const revoked = Boolean(key.revokedAt);
        if (revoked && !buckets.has(`key:${key.id}`)) continue;
        keys.push({ id: key.id, name: key.name, source: "api", revoked, days: daysOf(`key:${key.id}`) });
      }
      keys.sort((a, b) => Number(a.revoked) - Number(b.revoked) || a.id - b.id);
      if (buckets.has("panel")) keys.push({ id: null, name: null, source: "panel", revoked: false, days: daysOf("panel") });
    }
    return { timezone: zone, from: labels[0], to: labels[labels.length - 1], keys };
  }

  // ---- The test send (API-11) -------------------------------------------------------------------------------------

  const unlinkQuiet = async (file) => {
    try {
      await fs.promises.unlink(file);
    } catch {
      // already gone (the engine moved it) or never written
    }
  };

  async function testSend(raw, input = {}) {
    const at = input.at ?? Date.now();
    const apiState = getApiState();
    const failed = failure();
    if (failed) throw new AdminError("api_disabled", { params: { reason: "registry_failed", ...(failed.endpoint ? { endpoint: failed.endpoint } : {}) } });
    if (!apiState.isEnabled()) throw new AdminError("api_disabled", { params: { reason: "switch_off" } });

    const messaging = getMessaging();
    const { uploadId, ...body } = raw && typeof raw === "object" ? raw : {};
    const format = body.format;
    if (format === undefined || format === null) throw validationFailed({ format: { code: "required" } });
    if (typeof format !== "string") throw validationFailed({ format: { code: "invalid_type" } });
    if (body.to === undefined || body.to === null) throw validationFailed({ to: { code: "required" } });
    if (typeof body.to !== "string") throw validationFailed({ to: { code: "invalid_type" } });

    // the recipient (parse, own number, disabled chat) first, as the public pipeline does: the quote lookup needs it
    const target = await messaging.resolveRecipient(body.to, { policy: null });

    const faults = {};
    if (uploadId !== undefined) {
      if (typeof uploadId !== "string") faults.uploadId = { code: "invalid_type" };
      else if (!UPLOAD_ID.test(uploadId)) faults.uploadId = { code: "invalid_format" };
    }
    let validated = null;
    try {
      validated = await messaging.validateInput(format, body, { target, apiKeyId: null });
    } catch (err) {
      if (err instanceof MessagingError && err.code === "validation_failed") Object.assign(faults, err.fields || {});
      else throw err;
    }
    if (Object.keys(faults).length) throw validationFailed(faults);

    // media: exactly one source, an uploaded file (purpose=api, this session) or media.url
    const module_ = messaging.formats.get(format);
    const accepts = Boolean(module_ && module_.media);
    const uploads = getUploads();
    let upload = null;
    let file = null;
    let fetched = false;
    if (!accepts) {
      if (uploadId !== undefined) throw validationFailed({ uploadId: { code: "not_allowed" } });
    } else {
      const hasUrl = validated.mediaMarker === true;
      if (uploadId === undefined && !hasUrl) throw validationFailed({ media: { code: "required" } });
      if (uploadId !== undefined && hasUrl) throw validationFailed({ media: { code: "not_allowed" } });
      if (uploadId !== undefined) {
        upload = uploads ? uploads.peek(uploadId, input.sessionId, { purpose: "api" }) : null;
        // unknown, expired, foreign, consumed and wrong-purpose uploads are never told apart
        if (!upload) throw validationFailed({ uploadId: { code: "not_found" } });
        file = { path: upload.path, size: upload.size, name: upload.name };
      } else {
        file = await messaging.fetchMedia(format, body.media.url, { signal: input.signal });
        fetched = true;
      }
    }

    // `submit` detects the type again from the bytes and applies the cap (media_type_mismatch, media_too_large), then
    // admits (queue_full): the panel path relies on it alone (RT-12). A fetched file was inspected by fetchMedia.
    let accepted;
    try {
      accepted = await messaging.submit({
        source: "panel",
        apiKeyId: null,
        requestId: input.requestId || null,
        format: validated.format,
        to: validated.to,
        quote: validated.quote,
        fields: validated.fields,
        media: file
          ? { path: file.path, size: file.size, name: file.name, sha256: file.sha256, mode: fetched ? "move" : "copy", source: fetched ? "url" : "upload" }
          : null,
        policy: null,
        limits: null,
        idempotency: null,
        now: at,
      });
    } catch (err) {
      if (fetched && file) await unlinkQuiet(file.path); // a refused fetch is not left in data/tmp
      throw err;
    }
    if (fetched && file) await unlinkQuiet(file.path); // already moved when accepted: a missing file is fine

    // only after acceptance: a refused test leaves the upload for a retry with the other fields fixed
    if (upload) await uploads.consume(uploadId, input.sessionId, { purpose: "api" });

    const { ApiMessage } = getModels();
    const row = await ApiMessage.findOne({ where: { publicId: accepted.message.publicId }, attributes: MESSAGE_COLUMNS });
    const [message] = await presentRows([row]);
    return {
      message,
      audits: [{ action: "api.test", target: String(row.id), detail: { format: row.format, kind: message.kind } }],
    };
  }

  return {
    state,
    setState,
    catalog,
    listKeys,
    createKey,
    updateKey,
    duplicateKey,
    revokeKey,
    listMessages,
    getMessage,
    usage,
    testSend,
    openapi,
    originOf,
  };
}

module.exports = {
  createApiService,
  widenings,
  KEY_INPUT,
  KEY_UPDATE,
  KEY_DUPLICATE,
  KEY_REVOKE,
  STATE_INPUT,
  MESSAGES_QUERY,
  USAGE_QUERY,
  LIMITS,
  REASONS,
  WINDOW_MS,
  BASE_PATH,
};
