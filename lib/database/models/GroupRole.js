const { DataTypes } = require("sequelize");

/**
 * GroupRole Model - custom roles per (group, user)
 */
module.exports = (sequelize) => {
  const GroupRole = sequelize.define(
    "GroupRole",
    {
      groupJid: {
        type: DataTypes.STRING,
        primaryKey: true,
        allowNull: false,
      },
      userJid: {
        type: DataTypes.STRING,
        primaryKey: true,
        allowNull: false,
      },
      role: {
        type: DataTypes.ENUM("vip", "muted", "banned", "regular"),
        defaultValue: "regular",
        allowNull: false,
      },
      setBy: {
        type: DataTypes.STRING,
        defaultValue: null,
      },
      setAt: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
      },
    },
    {
      tableName: "group_roles",
      timestamps: true,
    }
  );

  return GroupRole;
};
