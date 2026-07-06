const { DataTypes } = require("sequelize");

/**
 * Quote Model - saved group quotes / memorable messages
 */
module.exports = (sequelize) => {
  const Quote = sequelize.define(
    "Quote",
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      groupJid: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      authorJid: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      authorName: {
        type: DataTypes.STRING,
        defaultValue: "",
      },
      text: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      savedBy: {
        type: DataTypes.STRING,
        allowNull: false,
      },
    },
    {
      tableName: "quotes",
      timestamps: true,
      indexes: [{ fields: ["groupJid", "createdAt"] }],
    },
  );

  return Quote;
};
