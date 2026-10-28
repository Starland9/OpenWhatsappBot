const { DataTypes } = require("sequelize");

/**
 * AdminAccount Model
 * The single administrator of the web panel (specs/002-admin-panel, data-model 1.1).
 * `id` is always 1 and inserted explicitly (no autoIncrement): the primary key
 * makes a second account impossible, also under a race between two setup requests.
 * The password is stored as a self-describing scrypt hash, never in clear.
 */
const UI_LANGS = ["en", "fr"];
const THEMES = ["auto", "light", "dark"];

module.exports = (sequelize) => {
  const AdminAccount = sequelize.define(
    "AdminAccount",
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: false,
        allowNull: false,
        validate: { isIn: [[1]] },
        comment: "Always 1, inserted explicitly: a second account is impossible",
      },
      passwordHash: {
        type: DataTypes.STRING(255),
        allowNull: false,
        comment: "scrypt$<N>$<r>$<p>$<saltB64>$<hashB64>; never serialized",
      },
      uiLang: {
        type: DataTypes.STRING(2),
        allowNull: true,
        defaultValue: "fr",
        validate: { isIn: [UI_LANGS] },
        comment: "Panel language: en | fr (independent of BOT_LANG)",
      },
      theme: {
        type: DataTypes.STRING(8),
        allowNull: true,
        defaultValue: "auto",
        validate: { isIn: [THEMES] },
        comment: "auto | light | dark",
      },
      lastLoginAt: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: "Set at each successful login",
      },
    },
    {
      tableName: "admin_accounts",
      timestamps: true,
    }
  );

  return AdminAccount;
};
