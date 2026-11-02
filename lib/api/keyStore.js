"use strict";

/**
 * API key store (feature 004, contracts/runtime.md section 15.7, data-model.md 1.7). Generates, verifies and
 * caches the keys of the public messaging API.
 *
 *   createKeyStore({ models, settingsCache, now, alerts, logger }) -> {
 *     generateSecret()        -> { secret, lookupId, secretHash, last4 }       `secret` is the WHOLE token (shown once)
 *     parseToken(text)        -> { lookupId, secret } | null                   shape check only; `secret` is the 43-character part
 *     lookup(token)           -> Promise<{ status: "malformed"|"unknown"|"mismatch"|"unavailable" } | { status: "ok", key }>
 *     invalidate(id?)         -> void     the panel service calls it in the same tick as every configuration write
 *     invalidateAll()         -> void
 *     touch(key, { ip, origin, at }) -> Promise|undefined    usage write-behind (the promise never rejects)
 *   }
 *
 * Token: `owbk_` + 16 hex (the lookup id, 64 random bits) + `_` + 43 base64url characters (the secret, 32 random
 * bytes). `secretHash` is the lower-case hex SHA-256 of the 43-character secret STRING as sent (not of decoded bytes:
 * base64url has non-canonical encodings of the same bytes). SHA-256 and not a slow KDF: 256 random bits cannot be
 * brute-forced from a stolen table, and a memory-hard KDF would charge every request tens of milliseconds (DoS
 * amplification, SC-010).
 *
 * Verification: the shape, then `Map.get(lookupId)` on the cache, then `crypto.timingSafeEqual` of the stored hash
 * against the SHA-256 of the presented secret; an unknown id compares against a dummy hash, so unknown, wrong secret
 * and right secret all cost the same operations and "missing / malformed / unknown / wrong" are indistinguishable by
 * time. The key state (revoked, expired, IP) is NOT decided here: `lookup` only returns the record, and the pipeline
 * looks at `revokedAtMs`, `expiresAtMs` and `ipAllow` after the secret matched (so `key_revoked`, `key_expired` and
 * `ip_not_allowed` leak nothing to someone without the whole secret).
 *
 * Cache: `settingsCache` key `api_keys`, 5 minutes, all rows including revoked, read through model instances. A load
 * failure with no previous value gives `unavailable` (fail closed). Every writer of configuration columns calls
 * `invalidate()` in the same tick, so a revocation applies to the very next request (FR-014).
 *
 * Usage write-behind: `touch` updates `lastUsedAt`, `lastIp` and `seenIps` (at most 20 origin keys, oldest dropped) in
 * the cached record and writes the row `silent: true` at most once per key per 60 s, and at once for a new origin; it
 * never bumps `version` and never invalidates the cache; no timer. A new origin on a key that already has some raises
 * the alert `api_key_new_ip`; the first origin of a key never does.
 *
 * Never logged: the token, its secret, the lookup id or the hash (Y9: a key is named by its integer id and name).
 */

const crypto = require("crypto");
const ipRules = require("./ipRules");

const TOKEN_PATTERN = /^owbk_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;
const CACHE_KEY = "api_keys";
const CACHE_TTL_MS = 5 * 60 * 1000;
const USAGE_WRITE_MS = 60 * 1000;
const SEEN_IPS_MAX = 20;
/** Compared against when the id is unknown, so that path costs what the others do */
const DUMMY_HASH = crypto.randomBytes(32);

const sha256 = (text) => crypto.createHash("sha256").update(text).digest();

/** A JSON column as an array (a damaged value is an empty list; SQLite may hand a string back) */
function asArray(value) {
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

const toMs = (value) => (value ? new Date(value).getTime() : null);

/** The in-memory form of an ApiKey row (data-model.md 1.7) */
function toRecord(row) {
  return {
    id: row.id,
    lookupId: row.lookupId,
    name: row.name,
    secretHash: row.secretHash,
    rights: new Set(asArray(row.rights)),
    policy: { mode: row.policyMode, entries: asArray(row.recipients) },
    limits: { perMinute: row.limitPerMinute ?? null, perDay: row.limitPerDay ?? null, maxPending: row.limitPending ?? null },
    ipAllow: ipRules.compile(asArray(row.ipAllow)),
    expiresAtMs: toMs(row.expiresAt),
    revokedAtMs: toMs(row.revokedAt),
    seenIps: new Set(asArray(row.seenIps)),
    lastUsedAtMs: toMs(row.lastUsedAt),
    lastIp: row.lastIp || null,
    usageWrittenAtMs: 0,
  };
}

function createKeyStore(options = {}) {
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const getModels = () => options.models || require("../database");
  const getCache = () => options.settingsCache || require("../utils/settingsCache");
  const getAlerts = () => options.alerts || require("../utils/alerts");
  const getLogger = () => options.logger || (options.logger = require("../utils/logger").createLogger("api"));

  async function loadKeys() {
    const rows = await getModels().ApiKey.findAll();
    const map = new Map();
    for (const row of rows) map.set(row.lookupId, toRecord(row));
    return map;
  }

  /** Map<lookupId, KeyRecord>, or null when the table cannot be read and nothing was cached before */
  const keys = () => getCache().getOrLoad(CACHE_KEY, loadKeys, CACHE_TTL_MS);

  function generateSecret() {
    const lookupId = crypto.randomBytes(8).toString("hex");
    const part = crypto.randomBytes(32).toString("base64url");
    const secret = `owbk_${lookupId}_${part}`;
    return { secret, lookupId, secretHash: sha256(part).toString("hex"), last4: secret.slice(-4) };
  }

  function parseToken(text) {
    if (typeof text !== "string" || text.length !== 65) return null;
    const match = TOKEN_PATTERN.exec(text);
    return match ? { lookupId: match[1], secret: match[2] } : null;
  }

  async function lookup(token) {
    const parsed = parseToken(token);
    if (!parsed) return { status: "malformed" };
    let map;
    try {
      map = await keys();
    } catch {
      map = null;
    }
    if (!(map instanceof Map)) return { status: "unavailable" };

    const record = map.get(parsed.lookupId) || null;
    let stored = DUMMY_HASH;
    if (record) {
      const bytes = Buffer.from(String(record.secretHash), "hex");
      if (bytes.length === 32) stored = bytes;
    }
    const equal = crypto.timingSafeEqual(stored, sha256(parsed.secret));
    if (!record) return { status: "unknown" };
    if (!equal) return { status: "mismatch" };
    return { status: "ok", key: record };
  }

  function invalidate() {
    getCache().invalidate(CACHE_KEY);
  }

  function touch(key, { ip, origin, at = now() } = {}) {
    if (!key || typeof key !== "object") return undefined;
    const known = key.seenIps.size > 0;
    const originKey = typeof origin === "string" && origin ? origin : null;
    const newOrigin = originKey !== null && !key.seenIps.has(originKey);

    key.lastUsedAtMs = at;
    if (typeof ip === "string" && ip) key.lastIp = ip.slice(0, 45);
    if (newOrigin) {
      key.seenIps.add(originKey);
      while (key.seenIps.size > SEEN_IPS_MAX) key.seenIps.delete(key.seenIps.values().next().value);
    }

    if (newOrigin && known) {
      try {
        Promise.resolve(getAlerts().raise("api_key_new_ip", { keyId: key.id, keyName: key.name, ip: key.lastIp })).catch(() => {});
      } catch {
        // an alert never fails a request
      }
    }

    if (!newOrigin && key.usageWrittenAtMs && at - key.usageWrittenAtMs < USAGE_WRITE_MS) return undefined;
    key.usageWrittenAtMs = at;
    const values = { lastUsedAt: new Date(at), lastIp: key.lastIp, seenIps: [...key.seenIps] };
    return Promise.resolve()
      .then(() => getModels().ApiKey.update(values, { where: { id: key.id }, silent: true }))
      .catch((err) => {
        getLogger().warn({ keyId: key.id, error: (err && err.name) || "Error" }, "api: key usage could not be recorded");
      });
  }

  return { generateSecret, parseToken, lookup, invalidate, invalidateAll: invalidate, touch };
}

module.exports = { createKeyStore, TOKEN_PATTERN, CACHE_KEY, CACHE_TTL_MS, USAGE_WRITE_MS, SEEN_IPS_MAX };
