"use strict";

/**
 * One-time setup and reset links (data-model 1.3 and 2.1, admin-http-api.md 2.1, FR-003, FR-007).
 *
 *   const tokens = createTokens({ models, now });
 *   await tokens.issue("setup" | "reset")     -> { token, kind, expiresAt, ttlMs }   deletes the unused tokens of that kind
 *   await tokens.validate(token, { kind })    -> { id, kind, expiresAt } | null      does NOT consume: a link scanner that only
 *                                                                                     fetches the page cannot burn the link
 *   await tokens.consume(token, { transaction, kind })  -> { id, kind, expiresAt }   inside the transaction that creates the account
 *                                                                                     or changes the password; throws token_invalid
 *   await tokens.deleteKind(kind, { transaction })      creating the account deletes every setup token
 *   tokens.buildLink(base, token)             -> `${base}/admin/setup?token=${token}`
 *
 * A token is 32 random bytes in base64url; only its SHA-256 is stored. A valid token is looked up among the
 * (at most two) live rows and compared to each with `crypto.timingSafeEqual`, with no early exit, so the
 * answer time does not depend on which byte differs. Expiry is judged with the injected clock.
 */

const crypto = require("crypto");
const { Op } = require("sequelize");
const { AdminError } = require("../http/response");

const TTL_MS = 30 * 60 * 1000;
const KINDS = Object.freeze(["setup", "reset"]);
/** 32 bytes in base64url: 43 characters (anything else cannot be one of ours). */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const sha256Hex = (text) => crypto.createHash("sha256").update(String(text)).digest("hex");

/** Base of the printed links: PANEL_PUBLIC_URL when set, else `http://localhost:<port>` (no trailing slash). */
function linkBase({ publicUrl, port } = {}) {
  const base = String(publicUrl || "").trim().replace(/\/+$/, "");
  return base || `http://localhost:${port || 3000}`;
}

/**
 * @param {object} [options]
 * @param {object} [options.models]    the database module (default: required lazily)
 * @param {() => number} [options.now]
 * @param {number} [options.ttlMs=1800000]
 */
function createTokens(options = {}) {
  const clock = typeof options.now === "function" ? options.now : () => Date.now();
  const ttlMs = options.ttlMs || TTL_MS;
  const modelsOf = () => options.models || require("../../database");

  /** The live (unused, unexpired) rows whose hash equals the token's, compared in constant time. */
  async function find(token, { kind, transaction } = {}) {
    if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return null;
    const { AdminToken } = modelsOf();
    const at = clock();
    const rows = await AdminToken.findAll({ where: { usedAt: null }, transaction });
    const wanted = Buffer.from(sha256Hex(token), "hex");
    let found = null;
    for (const row of rows) {
      const stored = Buffer.from(String(row.tokenHash), "hex");
      const same = stored.length === wanted.length && crypto.timingSafeEqual(stored, wanted);
      if (same && new Date(row.expiresAt).getTime() > at && (!kind || row.kind === kind)) found = row;
    }
    return found;
  }

  const record = (row) => ({ id: row.id, kind: row.kind, expiresAt: new Date(row.expiresAt).getTime() });

  return {
    ttlMs,
    KINDS,

    /** Create a fresh token of `kind`; the unused ones of that kind are deleted first (one live link per kind). */
    async issue(kind, { transaction } = {}) {
      if (!KINDS.includes(kind)) throw new TypeError(`unknown token kind: ${kind}`);
      const { AdminToken } = modelsOf();
      const token = crypto.randomBytes(32).toString("base64url");
      const at = clock();
      await AdminToken.destroy({ where: { kind, usedAt: null }, transaction });
      await AdminToken.create(
        { kind, tokenHash: sha256Hex(token), expiresAt: new Date(at + ttlMs), createdAt: new Date(at) },
        transaction ? { transaction } : {},
      );
      return { token, kind, expiresAt: at + ttlMs, ttlMs };
    },

    /** Check a token without consuming it. */
    async validate(token, opts = {}) {
      const row = await find(token, opts);
      return row ? record(row) : null;
    },

    /**
     * Mark a token used. The conditional UPDATE (`usedAt IS NULL`) makes two racing requests safe: only one
     * changes a row. Throws `token_invalid` when the token is unknown, expired or already used.
     */
    async consume(token, { transaction, kind } = {}) {
      const row = await find(token, { kind, transaction });
      if (!row) throw new AdminError("token_invalid");
      const { AdminToken } = modelsOf();
      const [changed] = await AdminToken.update(
        { usedAt: new Date(clock()) },
        { where: { id: row.id, usedAt: null }, transaction },
      );
      if (!changed) throw new AdminError("token_invalid");
      return record(row);
    },

    /** Delete the tokens of a kind (used or not); creating the account deletes every setup token. */
    async deleteKind(kind, { transaction } = {}) {
      const { AdminToken } = modelsOf();
      return AdminToken.destroy({ where: { kind }, transaction });
    },

    /** Is there an unused, unexpired token of this kind. */
    async hasLive(kind) {
      const { AdminToken } = modelsOf();
      const at = clock();
      const count = await AdminToken.count({ where: { kind, usedAt: null, expiresAt: { [Op.gt]: new Date(at) } } });
      return count > 0;
    },

    /** `<base>/admin/setup?token=<token>` (base without a trailing slash). */
    buildLink(base, token) {
      return `${String(base).replace(/\/+$/, "")}/admin/setup?token=${token}`;
    },
  };
}

module.exports = { createTokens, linkBase, TOKEN_PATTERN, TTL_MS, KINDS, sha256Hex };
