const { DataTypes } = require("sequelize");

/**
 * UserStats Model - per-(user, group) activity tracking for stats, leaderboards, leveling
 */
module.exports = (sequelize) => {
  const UserStats = sequelize.define(
    "UserStats",
    {
      jid: {
        type: DataTypes.STRING,
        primaryKey: true,
        allowNull: false,
      },
      groupJid: {
        type: DataTypes.STRING,
        primaryKey: true,
        allowNull: false,
      },
      messageCount: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
      },
      commandCount: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
      },
      mediaCount: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
      },
      xp: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
      },
      level: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
      },
      lastActiveAt: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
      },
    },
    {
      tableName: "user_stats",
      timestamps: true,
      indexes: [
        { fields: ["groupJid", "messageCount"] },
        { fields: ["groupJid", "xp"] },
        { fields: ["groupJid", "commandCount"] },
        { fields: ["groupJid", "mediaCount"] },
      ],
    },
  );

  return UserStats;
};
