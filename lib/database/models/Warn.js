const { DataTypes } = require('sequelize')

/**
 * Warn Model - For warning system
 */
module.exports = (sequelize) => {
  const Warn = sequelize.define('Warn', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    jid: {
      type: DataTypes.STRING,
      allowNull: false
    },
    groupJid: {
      type: DataTypes.STRING,
      allowNull: false
    },
    reason: {
      type: DataTypes.TEXT,
      defaultValue: 'No reason provided'
    },
    count: {
      type: DataTypes.INTEGER,
      defaultValue: 1
    }
  }, {
    tableName: 'warns',
    timestamps: true,
    indexes: [
      {
        unique: true,
        fields: ['jid', 'groupJid']
      }
    ]
  })

  return Warn
}
