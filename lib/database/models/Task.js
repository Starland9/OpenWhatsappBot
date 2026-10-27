const { DataTypes } = require("sequelize");

/**
 * Task Model
 * To-do list items of `.task`, one list per chat (at most 100 tasks per chat).
 * Delete and clear: the creator, a group admin or an owner.
 */
module.exports = (sequelize) => {
  const Task = sequelize.define(
    "Task",
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      chatJid: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: "Chat the list belongs to",
      },
      text: {
        type: DataTypes.TEXT,
        allowNull: false,
        validate: { len: [1, 300] },
        comment: "1 to 300 characters",
      },
      done: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      createdBy: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: "JID of the author (may delete the task)",
      },
      doneBy: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: "JID of the user who marked the task as done",
      },
    },
    {
      tableName: "tasks",
      timestamps: true,
      indexes: [{ fields: ["chatJid"] }],
    }
  );

  return Task;
};
