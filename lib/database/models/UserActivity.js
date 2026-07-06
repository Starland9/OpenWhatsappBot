const { DataTypes } = require("sequelize");

/**
 * UserActivity Model
 * Tracks per-user activity stats within each group
 */
module.exports = (sequelize) => {
  const UserActivity = sequelize.define(
    "UserActivity",
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      jid: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      groupJid: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      messageCount: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
      },
      voiceCount: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
      },
      stickerCount: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
      },
      mediaCount: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
      },
      lastActive: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
      },
    },
    {
      tableName: "user_activities",
      timestamps: true,
      indexes: [
        {
          unique: true,
          fields: ["jid", "groupJid"],
        },
      ],
    }
  );

  return UserActivity;
};
