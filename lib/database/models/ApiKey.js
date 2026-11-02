const { DataTypes } = require("sequelize");

// Literals repeated on purpose: lib/database/index.js requires every model synchronously, so a model cannot import
// an engine constant (lib/api/*, lib/messaging/*). A test pins that these equal the engine constants
// (specs/004-messaging-api/data-model.md 0.1).
const POLICY_MODES = ["list", "known", "anyone"];
const MAX_RIGHTS = 64;
const MAX_RECIPIENTS = 200;
const MAX_IP_ALLOW = 50;
const MAX_SEEN_IPS = 20;
const MAX_IP_TEXT = 50;
const RIGHT_ID = /^[a-z]+(\.[a-z0-9_]+)*$/;
const PN_JID = /^[1-9]\d{7,14}@s\.whatsapp\.net$/;
const GROUP_JID = /^\d{5,25}(-\d+)?@g\.us$/;

/** Array of at most `max` items, each accepted by `check(item)` (a boolean) */
const listOf = (label, max, check, shape) => (value) => {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > max) throw new Error(`${label}: at most ${max} items`);
  for (const item of value) {
    if (!check(item)) throw new Error(`${label}: each item must be ${shape}`);
  }
};

/** Integer inside [min, max], or NULL (Sequelize still calls a custom validator with a null value) */
const intBetween = (label, min, max) => (value) => {
  if (value === null || value === undefined) return;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
};

/**
 * ApiKey Model
 * A named access for an external program (specs/004-messaging-api, data-model 1). Only the SHA-256 of the secret
 * and its last 4 characters are stored, never the secret itself. `lookupId` and `secretHash` never leave the
 * process (no response, log or audit detail).
 *
 * Writers: the panel service lib/admin/services/api.js (configuration columns, under withLock("api-keys")) and
 * the key store lib/api/keyStore.js (usage columns `lastUsedAt`, `lastIp`, `seenIps`, written `silent`).
 * Read through the cached map `settingsCache` key "api_keys"; every configuration writer invalidates it.
 * Excluded from backups (lib/admin/backup/format.js EXCLUDED_MODELS).
 *
 * Name uniqueness among live keys: `nameKey` is `name.toLowerCase()` while the key is live and NULL once revoked;
 * the unique index ignores NULLs, so a revoked key frees its name. `revokedAt IS NULL <=> nameKey IS NOT NULL` and
 * `nameKey = name.toLowerCase()` are service invariants (a static Model.update runs partial validation).
 *
 * The array columns are JSON: read through model instances, never `raw: true` (a string on SQLite). The IP
 * grammar of `ipAllow` is lib/api/ipRules.js, not the model's.
 */
module.exports = (sequelize) => {
  const ApiKey = sequelize.define(
    "ApiKey",
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      name: {
        type: DataTypes.STRING(64),
        allowNull: false,
        validate: { notEmpty: true },
        comment: "Trimmed, NFKC, 1-64 code points (the service counts code points)",
      },
      nameKey: {
        type: DataTypes.STRING(128),
        allowNull: true,
        comment: "name.toLowerCase() while the key is live, NULL once revoked",
      },
      lookupId: {
        type: DataTypes.STRING(16),
        allowNull: false,
        validate: { is: /^[0-9a-f]{16}$/ },
        comment: "The 16 hex characters after owbk_ in the token; never logged",
      },
      secretHash: {
        type: DataTypes.STRING(64),
        allowNull: false,
        validate: { is: /^[0-9a-f]{64}$/ },
        comment: "Lower-case hex SHA-256 of the secret string; never serialised",
      },
      last4: {
        type: DataTypes.STRING(4),
        allowNull: false,
        comment: "Last 4 characters of the token, the only fragment ever displayed",
      },
      rights: {
        type: DataTypes.JSON,
        allowNull: false,
        defaultValue: [],
        validate: {
          rightList(value) {
            listOf("rights", MAX_RIGHTS, (id) => typeof id === "string" && id.length <= 64 && RIGHT_ID.test(id), "a right id")(value);
            if (new Set(value).size !== value.length) throw new Error("rights: no duplicate");
          },
        },
        comment: "At most 64 distinct right ids; deny by default",
      },
      policyMode: {
        type: DataTypes.STRING(8),
        allowNull: false,
        defaultValue: "list",
        validate: { isIn: [POLICY_MODES] },
        comment: "list | known | anyone",
      },
      recipients: {
        type: DataTypes.JSON,
        allowNull: false,
        defaultValue: [],
        validate: {
          recipientList: listOf(
            "recipients",
            MAX_RECIPIENTS,
            (jid) => typeof jid === "string" && (PN_JID.test(jid) || GROUP_JID.test(jid)),
            "a phone number or a group JID",
          ),
        },
        comment: "At most 200 normalised JIDs, never a LID; read in mode list, kept when the mode changes",
      },
      limitPerMinute: {
        type: DataTypes.INTEGER,
        allowNull: true,
        validate: { perMinute: intBetween("limitPerMinute", 1, 1000) },
        comment: "NULL = follow API_RATE_PER_MINUTE",
      },
      limitPerDay: {
        type: DataTypes.INTEGER,
        allowNull: true,
        validate: { perDay: intBetween("limitPerDay", 1, 100000) },
        comment: "NULL = follow API_RATE_PER_DAY",
      },
      limitPending: {
        type: DataTypes.INTEGER,
        allowNull: true,
        validate: { pending: intBetween("limitPending", 1, 5000) },
        comment: "NULL = follow API_MAX_PENDING",
      },
      ipAllow: {
        type: DataTypes.JSON,
        allowNull: false,
        defaultValue: [],
        validate: {
          ipList: listOf(
            "ipAllow",
            MAX_IP_ALLOW,
            (entry) => typeof entry === "string" && entry.length <= MAX_IP_TEXT,
            "a string of at most 50 characters",
          ),
        },
        comment: "At most 50 entries in the lib/api/ipRules.js grammar; empty = no restriction",
      },
      expiresAt: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: "NULL = never",
      },
      revokedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: "Set once by the revoke UPDATE, never cleared",
      },
      lastUsedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: "Last successful authentication, write-behind",
      },
      lastIp: {
        type: DataTypes.STRING(45),
        allowNull: true,
        comment: "Full effective client address of the last authenticated request",
      },
      seenIps: {
        type: DataTypes.JSON,
        allowNull: false,
        defaultValue: [],
        validate: {
          seenList: listOf(
            "seenIps",
            MAX_SEEN_IPS,
            (origin) => typeof origin === "string" && origin.length > 0 && origin.length <= 64,
            "an origin string",
          ),
        },
        comment: "At most 20 origin keys, oldest dropped; empty = never used",
      },
      version: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
        comment: "Optimistic concurrency of the panel update; never bumped by the usage columns",
      },
    },
    {
      tableName: "api_keys",
      timestamps: true,
      indexes: [
        { unique: true, fields: ["lookupId"] },
        { unique: true, fields: ["nameKey"] },
      ],
    }
  );

  return ApiKey;
};
