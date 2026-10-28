const { DataTypes } = require("sequelize");

/**
 * AdminToken Model
 * One-time first-run setup link and password-reset link
 * (specs/002-admin-panel, data-model 1.3). Only the SHA-256 of the token is
 * stored; the clear token is printed once to the console.
 *
 * Lifecycle: issued -> used | expired (30 minutes) | superseded (deleted)
 */
const KINDS = ["setup", "reset"];

module.exports = (sequelize) => {
  const AdminToken = sequelize.define(
    "AdminToken",
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      kind: {
        type: DataTypes.STRING(8),
        allowNull: false,
        validate: { isIn: [KINDS] },
        comment: "setup | reset",
      },
      tokenHash: {
        type: DataTypes.STRING(64),
        allowNull: false,
        comment: "Hex SHA-256 of 32 random bytes (base64url in the link)",
      },
      expiresAt: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: "createdAt + 30 minutes",
      },
      usedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: "Set in the transaction that creates the account / changes the password",
      },
    },
    {
      tableName: "admin_tokens",
      timestamps: true,
      indexes: [{ unique: true, fields: ["tokenHash"] }],
    }
  );

  return AdminToken;
};
