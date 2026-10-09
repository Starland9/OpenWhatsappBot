const { DataTypes } = require("sequelize");

/**
 * StickerCommand Model
 * Maps stickers to commands for stealth execution
 */
module.exports = (sequelize) => {
  const StickerCommand = sequelize.define(
    "StickerCommand",
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      stickerHash: {
        type: DataTypes.STRING,
        unique: true,
        allowNull: false,
        comment: "Unique hash of the sticker (fileSha256 in hex)",
      },
      command: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: 'Command to execute (e.g., "vv", "ping", "menu")',
      },
      createdBy: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: "JID of the user who created this binding",
      },
    },
    {
      tableName: "sticker_commands",
      timestamps: true,
      indexes: [
        {
          unique: true,
          fields: ["stickerHash"],
        },
      ],
    }
  );

  return StickerCommand;
};
