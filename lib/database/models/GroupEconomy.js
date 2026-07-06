const { DataTypes } = require("sequelize");

/**
 * GroupEconomy Model - per-(group, user) virtual currency
 */
module.exports = (sequelize) => {
  const GroupEconomy = sequelize.define(
    "GroupEconomy",
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
      balance: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
      },
      lastDailyAt: {
        type: DataTypes.DATE,
        defaultValue: null,
      },
      streak: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
      },
    },
    {
      tableName: "group_economy",
      timestamps: true,
      indexes: [{ fields: ["groupJid", "balance"] }],
    },
  );

  return GroupEconomy;
};
