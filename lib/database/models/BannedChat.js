const { DataTypes } = require("sequelize");

/**
 * BannedChat Model
 * Chats (groups or private chats) where the bot is disabled by an owner.
 * Read through the cached set `settingsCache` key "banned_chats".
 */
module.exports = (sequelize) => {
  const BannedChat = sequelize.define(
    "BannedChat",
    {
      jid: {
        type: DataTypes.STRING,
        primaryKey: true,
        allowNull: false,
        comment: "Group or private chat JID",
      },
      bannedBy: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: "JID of the owner who disabled the bot in this chat",
      },
    },
    {
      tableName: "banned_chats",
      timestamps: true,
    }
  );

  return BannedChat;
};
