const { DataTypes } = require('sequelize')

/**
 * Auto Responder Settings Model
 */
module.exports = (sequelize) => {
  const AutoResponder = sequelize.define('AutoResponder', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    ignoreNumbers: {
      type: DataTypes.TEXT,
      defaultValue: ''
    },
    personality: {
      type: DataTypes.TEXT,
      defaultValue: 'You are a helpful and friendly assistant. Respond naturally and conversationally.'
    },
    enabled: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    }
  }, {
    tableName: 'auto_responder',
    timestamps: true
  })

  return AutoResponder
}
