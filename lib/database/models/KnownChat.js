const { DataTypes } = require("sequelize");

/**
 * KnownChat Model
 * Chats the panel may offer as broadcast destinations, and the list of former
 * groups (specs/002-admin-panel, data-model 1.9). Filled through
 * lib/utils/knownChats.js (hook plugin plugins/knownchats.js).
 */
const KINDS = ["private", "group"];

module.exports = (sequelize) => {
  const KnownChat = sequelize.define(
    "KnownChat",
    {
      jid: {
        type: DataTypes.STRING,
        primaryKey: true,
        allowNull: false,
        comment: "@s.whatsapp.net or @lid (private), @g.us (group); never status@broadcast",
      },
      kind: {
        type: DataTypes.STRING(8),
        allowNull: false,
        validate: { isIn: [KINDS] },
        comment: "private | group",
      },
      pnJid: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: "Phone-number form, to de-duplicate a person seen as PN and as LID",
      },
      name: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: "pushName (private) or subject (group)",
      },
      firstSeenAt: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      lastSeenAt: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      leftAt: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: "Group no longer listed by the bot (former group); cleared when it is back",
      },
    },
    {
      tableName: "known_chats",
      timestamps: true,
      indexes: [{ fields: ["kind", "lastSeenAt"] }, { fields: ["pnJid"] }],
    }
  );

  return KnownChat;
};
