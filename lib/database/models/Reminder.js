const { DataTypes } = require("sequelize");

/**
 * Reminder Model
 * Scheduled reminders created with `.remind` and delivered by
 * lib/utils/scheduler.js. Every status change is an idempotent
 * `UPDATE ... WHERE id = ? AND status = 'pending'`.
 *
 * Lifecycle: pending -> sent | cancelled | missed | failed
 */
const STATUSES = ["pending", "sent", "cancelled", "missed", "failed"];

module.exports = (sequelize) => {
  const Reminder = sequelize.define(
    "Reminder",
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        comment: "Shown to the user for `.remind cancel <id>`",
      },
      chatJid: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: "Chat where the reminder is delivered",
      },
      creatorJid: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: "Author of the reminder, mentioned on delivery",
      },
      text: {
        type: DataTypes.TEXT,
        allowNull: false,
        validate: { len: [1, 500] },
        comment: "1 to 500 characters",
      },
      dueAt: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: "Delivery time (UTC). Moved forward while a send is leased or retried",
      },
      status: {
        type: DataTypes.STRING,
        allowNull: false,
        defaultValue: "pending",
        validate: { isIn: [STATUSES] },
        comment: "pending | sent | cancelled | missed | failed",
      },
      attempts: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: "Send attempts so far; `failed` after 5",
      },
      lastError: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: "Last send error, for logs only (never shown to users)",
      },
      sentAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
    },
    {
      tableName: "reminders",
      timestamps: true,
      indexes: [
        { fields: ["dueAt"] },
        { fields: ["status", "dueAt"] },
        { fields: ["creatorJid", "status"] },
      ],
    }
  );

  return Reminder;
};
