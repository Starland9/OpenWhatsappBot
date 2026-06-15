const { DataTypes } = require('sequelize')
const config = require('../../../config')

/**
 * User Model
 */
module.exports = (sequelize) => {
  const User = sequelize.define('User', {
    jid: {
      type: DataTypes.STRING,
      primaryKey: true,
      allowNull: false
    },
    name: {
      type: DataTypes.STRING,
      defaultValue: ''
    },
    isBlocked: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    lastSeen: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    },
    afkReason: {
      type: DataTypes.TEXT,
      defaultValue: null
    },
    afkTime: {
      type: DataTypes.DATE,
      defaultValue: null
    }
  }, {
    tableName: 'users',
    timestamps: true
  })

  return User
}
