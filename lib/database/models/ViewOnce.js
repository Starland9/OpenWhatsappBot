const { DataTypes } = require('sequelize')

/**
 * ViewOnce Settings Model
 * Stores settings for automatic view-once message forwarding
 */
module.exports = (sequelize) => {
  const ViewOnce = sequelize.define('ViewOnce', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    vvMode: {
      type: DataTypes.STRING,
      defaultValue: 'null',
      comment: 'VV mode: p (private/sudo), g (group), jid (specific jid), null/false (disabled)'
    },
    vvJid: {
      type: DataTypes.STRING,
      defaultValue: null,
      comment: 'Specific JID when vvMode is a JID'
    },
    enabled: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    }
  }, {
    tableName: 'view_once',
    timestamps: true
  })

  return ViewOnce
}
