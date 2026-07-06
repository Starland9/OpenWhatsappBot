const { DataTypes } = require("sequelize");

/**
 * Reputation Model
 * Tracks per-user reputation within each group
 */
module.exports = (sequelize) => {
  const Reputation = sequelize.define(
    "Reputation",
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
      reputation: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
      },
      lastGiven: {
        type: DataTypes.DATE,
        allowNull: true,
      },
    },
    {
      tableName: "reputations",
      timestamps: true,
      indexes: [
        {
          unique: true,
          fields: ["jid", "groupJid"],
        },
      ],
    },
  );

  return Reputation;
};
