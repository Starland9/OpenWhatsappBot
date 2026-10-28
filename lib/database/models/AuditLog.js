const { DataTypes } = require("sequelize");

/**
 * AuditLog Model
 * History of administration actions, never a secret value
 * (specs/002-admin-panel, data-model 1.7). Written by lib/utils/audit.js only.
 * `action` is a dotted name from the vocabulary kept in that module, so it is
 * not constrained here (stores add entries as needed). Only `createdAt` exists.
 */
const RESULTS = ["ok", "fail", "blocked"];

module.exports = (sequelize) => {
  const AuditLog = sequelize.define(
    "AuditLog",
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      action: {
        type: DataTypes.STRING(48),
        allowNull: false,
        comment: "Dotted name: login.success, setting.update, command.toggle...",
      },
      target: {
        type: DataTypes.STRING(255),
        allowNull: true,
        comment: "Setting key, command, <groupJid>:<userJid>, broadcast id...",
      },
      origin: {
        type: DataTypes.STRING(64),
        allowNull: true,
        comment: "Client address key of the request (null for bot-side events)",
      },
      result: {
        type: DataTypes.STRING(12),
        allowNull: false,
        defaultValue: "ok",
        validate: { isIn: [RESULTS] },
        comment: "ok | fail | blocked",
      },
      detail: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: "Sanitized JSON, at most 2000 characters",
      },
    },
    {
      tableName: "audit_logs",
      timestamps: true,
      updatedAt: false,
      indexes: [
        { fields: ["createdAt"] },
        { fields: ["action", "createdAt"] },
        { fields: ["origin", "createdAt"] },
      ],
    }
  );

  return AuditLog;
};
