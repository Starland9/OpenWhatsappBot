const { DataTypes } = require('sequelize')

/**
 * AntiDelete Settings Model
 * Stores settings for automatic deleted message recovery
 */
module.exports = (sequelize) => {
  const AntiDelete = sequelize.define('AntiDelete', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    antiDelMode: {
      type: DataTypes.STRING,
      defaultValue: 'null',
      comment: 'Anti-delete mode: p (private/sudo), g (group), sudo (sudo only), jid (specific jid), null/false (disabled)'
    },
    antiDelJid: {
      type: DataTypes.STRING,
      defaultValue: null,
      comment: 'Specific JID when antiDelMode is a JID'
    },
    enabled: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    }
  }, {
    tableName: 'anti_delete',
    timestamps: true
  })

  return AntiDelete
}
