const { DataTypes } = require("sequelize");

/**
 * NotifyKeyword Model
 * Keywords watched with `.notify add`. A keyword is scoped to the group where
 * it was registered: alerts only come from that group, and only while the user
 * is still a member (plugins/notify.js). At most 20 keywords per user.
 */
module.exports = (sequelize) => {
  const NotifyKeyword = sequelize.define(
    "NotifyKeyword",
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      userJid: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: "Who receives the alert by DM",
      },
      keyword: {
        type: DataTypes.STRING,
        allowNull: false,
        validate: { len: [3, 50] },
        comment: "Lower-cased, at least 3 characters, matched on word boundaries",
      },
      scopeJid: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: "Group where the keyword was registered",
      },
      enabled: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
    },
    {
      tableName: "notify_keywords",
      timestamps: true,
      // No unique index: under `sync({ alter: true })` SQLite turns a composite
      // unique index into one UNIQUE constraint per column. Duplicates are
      // avoided by plugins/notify.js.
      indexes: [{ fields: ["userJid"] }, { fields: ["scopeJid"] }],
    }
  );

  return NotifyKeyword;
};
