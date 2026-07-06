const { DataTypes } = require("sequelize");

/**
 * GameScore Model
 * Tracks per-user game scores/wins/losses per game per group
 */
module.exports = (sequelize) => {
  const GameScore = sequelize.define(
    "GameScore",
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
      game: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      score: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
      },
      wins: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
      },
      losses: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
      },
    },
    {
      tableName: "game_scores",
      timestamps: true,
      indexes: [
        {
          unique: true,
          fields: ["jid", "groupJid", "game"],
        },
      ],
    },
  );

  return GameScore;
};
