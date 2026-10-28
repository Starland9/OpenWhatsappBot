const { DataTypes } = require("sequelize");

/**
 * AdminSession Model
 * An open panel access after login (specs/002-admin-panel, data-model 1.2).
 * Only the SHA-256 of the cookie value is stored, so a copy of the database
 * yields no usable cookie. Expiry: 24 h idle (`lastSeenAt`), 7 days absolute
 * (`createdAt`); at most 10 live rows (the oldest is dropped by the service).
 */
module.exports = (sequelize) => {
  const AdminSession = sequelize.define(
    "AdminSession",
    {
      idHash: {
        type: DataTypes.STRING(64),
        primaryKey: true,
        allowNull: false,
        comment: "Hex SHA-256 of the 32-byte random cookie value",
      },
      csrfSecret: {
        type: DataTypes.STRING(64),
        allowNull: false,
        comment: "Per-session CSRF token (X-CSRF-Token)",
      },
      origin: {
        type: DataTypes.STRING(64),
        allowNull: false,
        comment: "Client address key at login (IPv4, or IPv6 grouped by /64)",
      },
      userAgent: {
        type: DataTypes.STRING(200),
        allowNull: true,
        comment: "Truncated, display only",
      },
      lastSeenAt: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: "Sliding idle clock; write-behind, at most one write per 60 s",
      },
    },
    {
      tableName: "admin_sessions",
      timestamps: true,
      indexes: [{ fields: ["lastSeenAt"] }],
    }
  );

  return AdminSession;
};
