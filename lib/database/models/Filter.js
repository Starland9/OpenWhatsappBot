const { DataTypes } = require('sequelize')

/**
 * Filter Model - For auto-reply filters
 */
module.exports = (sequelize) => {
  const Filter = sequelize.define('Filter', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    pattern: {
      type: DataTypes.STRING,
      allowNull: false
    },
    response: {
      type: DataTypes.TEXT,
      allowNull: false
    },
    groupJid: {
      type: DataTypes.STRING,
      allowNull: true
    },
    isGlobal: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    }
  }, {
    tableName: 'filters',
    timestamps: true
  })

  return Filter
}
