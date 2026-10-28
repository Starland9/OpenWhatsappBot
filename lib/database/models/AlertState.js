const { DataTypes } = require("sequelize");

/**
 * AlertState Model
 * Persisted rate-limit slots and connection heartbeat for the alerts, so a
 * restart cannot re-spam (specs/002-admin-panel, data-model 1.13). Slots are
 * taken by compare-and-swap on `lastSentAt` (lib/utils/alerts.js).
 */
module.exports = (sequelize) => {
  const AlertState = sequelize.define(
    "AlertState",
    {
      key: {
        type: DataTypes.STRING(96),
        primaryKey: true,
        allowNull: false,
        comment: "reconnected | errors_series | key_refused:<service> | login_blocked:<origin> | update_available | conn_heartbeat",
      },
      lastSentAt: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: "Last time the slot was taken",
      },
      value: {
        type: DataTypes.STRING(255),
        allowNull: true,
        comment: "conn_heartbeat: ISO timestamp; update_available: last notified version",
      },
      count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: "Alerts allowed through this slot",
      },
    },
    {
      tableName: "alert_states",
      timestamps: true,
    }
  );

  return AlertState;
};
