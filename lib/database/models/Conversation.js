const { DataTypes } = require('sequelize')

/**
 * Conversation Context Model for Auto Responder
 */
module.exports = (sequelize) => {
  const Conversation = sequelize.define('Conversation', {
    jid: {
      type: DataTypes.STRING,
      primaryKey: true,
      allowNull: false
    },
    context: {
      type: DataTypes.JSON,
      defaultValue: []
    },
    lastMessageTime: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    }
  }, {
    tableName: 'conversations',
    timestamps: true,
    indexes: [
      {
        fields: ['lastMessageTime']
      }
    ]
  })

  return Conversation
}
