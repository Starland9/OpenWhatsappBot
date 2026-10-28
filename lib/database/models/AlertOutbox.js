const { DataTypes } = require("sequelize");

/**
 * AlertOutbox Model
 * Queue of alerts born while the bot is disconnected, flushed at reconnection
 * (specs/002-admin-panel, data-model 1.14). Payloads carry service names,
 * versions, durations, origins and times, never a key or a stack.
 *
 * Lifecycle: pending -> sent | expired (older than 24 h) | dropped
 */
const TYPES = ["reconnected", "errors_series", "key_refused", "login_blocked", "new_origin", "update_available"];
const STATUSES = ["pending", "sent", "expired", "dropped"];

module.exports = (sequelize) => {
  const AlertOutbox = sequelize.define(
    "AlertOutbox",
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      type: {
        type: DataTypes.STRING(24),
        allowNull: false,
        validate: { isIn: [TYPES] },
        comment: "reconnected | errors_series | key_refused | login_blocked | new_origin | update_available",
      },
      payload: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: "JSON, never a secret",
      },
      status: {
        type: DataTypes.STRING(10),
        allowNull: false,
        defaultValue: "pending",
        validate: { isIn: [STATUSES] },
        comment: "pending | sent | expired | dropped",
      },
      attempts: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: "Send attempts, at most 3",
      },
      sentAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
    },
    {
      tableName: "alert_outbox",
      timestamps: true,
      indexes: [{ fields: ["status", "createdAt"] }],
    }
  );

  return AlertOutbox;
};
