const { DataTypes } = require("sequelize");

/**
 * CommandState Model
 * Commands disabled globally or in one group (specs/002-admin-panel,
 * data-model 1.5). A row means "disabled"; re-enabling deletes the row.
 * Read through the cached set `settingsCache` key "command_state"
 * (lib/utils/commandState.js).
 */
module.exports = (sequelize) => {
  const CommandState = sequelize.define(
    "CommandState",
    {
      command: {
        type: DataTypes.STRING(64),
        primaryKey: true,
        allowNull: false,
        comment: "Registry entry name (first alias, lower case)",
      },
      scope: {
        type: DataTypes.STRING(255),
        primaryKey: true,
        allowNull: false,
        defaultValue: "*",
        comment: "* = global, otherwise a group JID",
      },
    },
    {
      tableName: "command_states",
      timestamps: true,
    }
  );

  return CommandState;
};
