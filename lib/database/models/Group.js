const { DataTypes } = require("sequelize");

/**
 * Group Model
 */
module.exports = (sequelize) => {
  const Group = sequelize.define(
    "Group",
    {
      jid: {
        type: DataTypes.STRING,
        primaryKey: true,
        allowNull: false,
      },
      name: {
        type: DataTypes.STRING,
        defaultValue: "",
      },
      antilink: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
      },
      antibot: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
      },
      mute: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
      },
      welcome: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
      },
      welcomeMsg: {
        type: DataTypes.TEXT,
        defaultValue: "Welcome @user to @group",
      },
      goodbyeMsg: {
        type: DataTypes.TEXT,
        defaultValue: "Goodbye @user",
      },
      // Action ou Vérité settings
      truthDareEnabled: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
      },
      truthDareMode: {
        type: DataTypes.STRING,
        defaultValue: "mild",
      },
      // Advanced group controls
      antiflood: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
      },
      bannedWords: {
        type: DataTypes.TEXT,
        defaultValue: "",
      },
      rules: {
        type: DataTypes.TEXT,
        defaultValue: "",
      },
      captchaEnabled: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
      },
    },
    {
      tableName: "groups",
      timestamps: true,
    },
  );

  return Group;
};
