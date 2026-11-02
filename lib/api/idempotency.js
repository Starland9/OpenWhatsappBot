"use strict";

/**
 * Idempotency of the public messaging API (feature 004, contracts/runtime.md section 15.8, public-api.md 7.4, FR-034).
 *
 *   fingerprint({ secretHashHex, endpointId, rawBody, fileSha256 }) -> 32 hex characters
 *   lookup({ messaging, apiKeyId, key, now })                       -> Promise<{ message, requestHash } | null>
 *   compare(stored, fingerprint)                                    throws ApiError("idempotency_conflict") when they differ
 *   canonicalJson(value)                                            JSON with the keys sorted recursively
 *
 * The fingerprint is the hex HMAC-SHA256 of `endpointId \0 canonicalJson(rawBody) \0 (fileSha256 or "")`, keyed with
 * the `secretHash` bytes of the API key and truncated to 32 characters: no content is stored, the key differs per API
 * key (no cross-install dictionary), and the JSON is judged exactly as sent (keys in any order, but an explicitly sent
 * default counts as a difference). `wait` (a query parameter) and the `Idempotency-Key` header are not part of it, nor
 * the name or declared type of the file part; for `media.url` the URL string counts, not the downloaded bytes.
 *
 * The window is `LIMITS.IDEMPOTENCY_MS` (24 h, fixed): `messaging.findByIdempotency` releases an older key lazily.
 * Only an accepted request is remembered, so a refused one leaves the key free. A lost race arrives as `submit`
 * returning `{ replayed: true, requestHash }`, which the pipeline compares the same way.
 */

const crypto = require("crypto");
const { ApiError } = require("./errors");

/** JSON text with object keys sorted recursively (arrays keep their order) */
function canonicalJson(value) {
  const sorted = (item) => {
    if (Array.isArray(item)) return item.map(sorted);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, sorted(item[key])]));
    }
    return item;
  };
  return JSON.stringify(sorted(value));
}

function fingerprint({ secretHashHex, endpointId, rawBody, fileSha256 }) {
  const data = `${endpointId}\u0000${canonicalJson(rawBody === undefined ? null : rawBody)}\u0000${fileSha256 || ""}`;
  return crypto.createHmac("sha256", Buffer.from(String(secretHashHex), "hex")).update(data).digest("hex").slice(0, 32);
}

function lookup({ messaging, apiKeyId, key, now }) {
  return messaging.findByIdempotency({ apiKeyId, key, now });
}

function compare(stored, fingerprintHex) {
  const expected = stored && typeof stored.requestHash === "string" ? stored.requestHash : null;
  if (expected === null || expected !== fingerprintHex) throw new ApiError("idempotency_conflict");
}

module.exports = { fingerprint, lookup, compare, canonicalJson };
