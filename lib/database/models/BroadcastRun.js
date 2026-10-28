const { DataTypes } = require("sequelize");

/**
 * BroadcastRun Model
 * One occurrence of a broadcast (the only run of a `once` broadcast, one per
 * date for a recurring one), the unit of "exactly once per occurrence"
 * (specs/002-admin-panel, data-model 1.11). The unique index
 * (broadcastId, dueAt) makes that a database invariant.
 *
 * Lifecycle: scheduled -> running -> completed | failed | cancelled | expired
 */
const STATUSES = ["scheduled", "running", "completed", "failed", "cancelled", "expired"];

module.exports = (sequelize) => {
  const BroadcastRun = sequelize.define(
    "BroadcastRun",
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      broadcastId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: "Logical link to broadcasts.id (no foreign key)",
      },
      dueAt: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: "The occurrence instant (UTC); the creation time for send-now",
      },
      status: {
        type: DataTypes.STRING(10),
        allowNull: false,
        defaultValue: "scheduled",
        validate: { isIn: [STATUSES] },
        comment: "scheduled | running | completed | failed | cancelled | expired",
      },
      total: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: "Number of targets materialized",
      },
      targetsReady: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: "Set to true last; the engine ignores a run whose targets are not ready",
      },
      startedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: "Set by the first claim",
      },
      finishedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: "Set on completed, failed, cancelled, expired",
      },
      note: {
        type: DataTypes.STRING(100),
        allowNull: true,
        comment: "late (expired for lateness / skipped occurrence) | stale (closed by the 24 h safety)",
      },
    },
    {
      tableName: "broadcast_runs",
      timestamps: true,
      indexes: [
        { unique: true, fields: ["broadcastId", "dueAt"] },
        { fields: ["status", "dueAt"] },
      ],
    }
  );

  return BroadcastRun;
};
