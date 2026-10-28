const { DataTypes } = require("sequelize");

/**
 * BroadcastTarget Model
 * One delivery to one destination for one run (specs/002-admin-panel,
 * data-model 1.12). "At most once per destination" is a pair of CAS updates
 * (pending -> sending -> sent) plus the unique index (runId, chatJid).
 *
 * Lifecycle: pending -> sending -> sent | failed ; pending -> cancelled
 */
const STATUSES = ["pending", "sending", "sent", "failed", "cancelled"];

module.exports = (sequelize) => {
  const BroadcastTarget = sequelize.define(
    "BroadcastTarget",
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      runId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: "Logical link to broadcast_runs.id (no foreign key)",
      },
      chatJid: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      position: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: "Send order inside the run",
      },
      status: {
        type: DataTypes.STRING(10),
        allowNull: false,
        defaultValue: "pending",
        validate: { isIn: [STATUSES] },
        comment: "pending | sending | sent | failed | cancelled",
      },
      attempts: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: "Incremented by the claim",
      },
      leaseUntil: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: "Claim time + 60 s; an expired lease means the process died mid-send",
      },
      sentAt: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: "Also the source of the global pacing clock",
      },
      messageId: {
        type: DataTypes.STRING(64),
        allowNull: true,
        comment: "WhatsApp message id on success",
      },
      errorCode: {
        type: DataTypes.STRING(40),
        allowNull: true,
        comment: "A code, never raw error text: forbidden, not_found, timeout, connection_closed, error, interrupted",
      },
    },
    {
      tableName: "broadcast_targets",
      timestamps: true,
      indexes: [
        { unique: true, fields: ["runId", "chatJid"] },
        { fields: ["runId", "status", "position"] },
        { fields: ["sentAt"] },
      ],
    }
  );

  return BroadcastTarget;
};
