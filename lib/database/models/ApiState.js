const { DataTypes } = require("sequelize");

// Literals repeated on purpose (see ApiKey.js). The grammar of the entries is lib/api/ipRules.js, validated by
// lib/utils/apiState.js#setPlainHttpFrom: a model cannot import it.
const MAX_PLAIN_HTTP = 20;
const MAX_ENTRY_TEXT = 50;

/**
 * ApiState Model
 * The messaging API's on/off switch and the plain-HTTP network list: a singleton row, id 1
 * (specs/004-messaging-api, data-model 4). Not a catalog setting: the settings page, config.env and a restore reach
 * settings without the password, this row has exactly one writer (lib/utils/apiState.js, behind the panel step-up).
 * `updatedAt` is the "changed at" shown by the panel; there is no `changedBy` (the audit row records the actor).
 *
 * No row is created by a read: the absence of the row means `{ enabled: false, plainHttpFrom: [] }`; the first
 * write upserts id 1. Excluded from backups: a restore never switches the API on or widens the network list.
 * `plainHttpFrom` is JSON: read through model instances, never `raw: true`.
 */
module.exports = (sequelize) => {
  const ApiState = sequelize.define(
    "ApiState",
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        allowNull: false,
        defaultValue: 1,
        validate: { isIn: [[1]] },
        comment: "Always 1",
      },
      enabled: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: "The switch; apiState.isEnabled() also needs the admin panel",
      },
      plainHttpFrom: {
        type: DataTypes.JSON,
        allowNull: false,
        defaultValue: [],
        validate: {
          networkList(value) {
            if (!Array.isArray(value)) throw new Error("plainHttpFrom must be an array");
            if (value.length > MAX_PLAIN_HTTP) throw new Error(`plainHttpFrom: at most ${MAX_PLAIN_HTTP} items`);
            for (const entry of value) {
              if (typeof entry !== "string" || entry.length > MAX_ENTRY_TEXT) {
                throw new Error(`plainHttpFrom: each item must be a string of at most ${MAX_ENTRY_TEXT} characters`);
              }
            }
          },
        },
        comment: "Private networks allowed to call over plain HTTP, at most 20, canonical grammar",
      },
    },
    {
      tableName: "api_state",
      timestamps: true,
    }
  );

  return ApiState;
};
