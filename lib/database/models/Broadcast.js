const { DataTypes } = require("sequelize");

/**
 * Broadcast Model
 * The definition of a broadcast: content, destinations, pacing, schedule or
 * recurrence rule (specs/002-admin-panel, data-model 1.10). Occurrences are
 * BroadcastRun rows, deliveries are BroadcastTarget rows (no foreign keys:
 * cascades are done by lib/admin/stores/broadcast.js, children first).
 *
 * `once`: send now (`runAt` null) or at `runAt`; the recurrence fields and
 * `nextRunAt` stay null. `recurring`: `recurKind` and `recurTime` required,
 * `recurDays` for weekly/monthly, `runAt` null. Enforced by the model-level
 * `rules` validator (create/save).
 */
const KINDS = ["once", "recurring"];
const STATUSES = ["active", "paused"];
const MEDIA_KINDS = ["image", "document"];
const RECUR_KINDS = ["daily", "weekly", "monthly"];

const MAX_TARGETS = 200;
const MIN_SPACING_MS = 2000;
const MAX_SPACING_MS = 600000;

const isBlank = (v) => v === null || v === undefined || v === "";

module.exports = (sequelize) => {
  const Broadcast = sequelize.define(
    "Broadcast",
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      kind: {
        type: DataTypes.STRING(10),
        allowNull: false,
        validate: { isIn: [KINDS] },
        comment: "once | recurring",
      },
      title: {
        type: DataTypes.STRING(100),
        allowNull: true,
        comment: "Owner's label",
      },
      text: {
        type: DataTypes.TEXT,
        allowNull: false,
        comment: "Message or media caption",
      },
      mediaKind: {
        type: DataTypes.STRING(10),
        allowNull: true,
        validate: { isIn: [MEDIA_KINDS] },
        comment: "image | document, at most one media",
      },
      mediaPath: {
        type: DataTypes.STRING(255),
        allowNull: true,
        comment: "data/broadcast-media/<id>/<sanitizedName>; NULL once the file is deleted",
      },
      mediaName: {
        type: DataTypes.STRING(255),
        allowNull: true,
        comment: "Sanitized display name",
      },
      mediaMime: {
        type: DataTypes.STRING(100),
        allowNull: true,
        comment: "Sniffed, never trusted from the client header",
      },
      mediaSize: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: "Bytes",
      },
      targets: {
        type: DataTypes.JSON,
        allowNull: false,
        validate: {
          jidList(value) {
            if (!Array.isArray(value) || value.length < 1 || value.length > MAX_TARGETS) {
              throw new Error(`targets must be an array of 1 to ${MAX_TARGETS} JIDs`);
            }
            if (value.some((jid) => typeof jid !== "string" || !jid)) {
              throw new Error("targets must only contain non-empty JID strings");
            }
          },
        },
        comment: "Array of 1 to 200 JIDs, validated against KnownChat at create/edit",
      },
      spacingMs: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 5000,
        validate: { min: MIN_SPACING_MS, max: MAX_SPACING_MS },
        comment: "Delay between two destinations, default 5 s, never less than 2 s",
      },
      status: {
        type: DataTypes.STRING(10),
        allowNull: false,
        defaultValue: "active",
        validate: { isIn: [STATUSES] },
        comment: "active | paused (recurring only)",
      },
      runAt: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: "once: scheduled time; null = send now",
      },
      recurKind: {
        type: DataTypes.STRING(10),
        allowNull: true,
        validate: { isIn: [RECUR_KINDS] },
        comment: "daily | weekly | monthly",
      },
      recurDays: {
        type: DataTypes.STRING(20),
        allowNull: true,
        comment: "weekly: ISO weekdays 1,3,5 (Monday=1); monthly: day of month 1 to 31",
      },
      recurTime: {
        type: DataTypes.STRING(5),
        allowNull: true,
        comment: "HH:mm in config.TIMEZONE",
      },
      nextRunAt: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: "Next occurrence (recurring), the engine's single indexed range",
      },
      lastRunAt: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: "Last occurrence materialized",
      },
    },
    {
      tableName: "broadcasts",
      timestamps: true,
      indexes: [{ fields: ["status", "nextRunAt"] }],
      validate: {
        rules() {
          if (this.kind === "once") {
            for (const field of ["recurKind", "recurDays", "recurTime", "nextRunAt"]) {
              if (!isBlank(this[field])) throw new Error(`${field} must be empty for a once broadcast`);
            }
          } else if (this.kind === "recurring") {
            if (!isBlank(this.runAt)) throw new Error("runAt must be empty for a recurring broadcast");
            if (isBlank(this.recurKind)) throw new Error("recurKind is required for a recurring broadcast");
            if (isBlank(this.recurTime)) throw new Error("recurTime is required for a recurring broadcast");
            if ((this.recurKind === "weekly" || this.recurKind === "monthly") && isBlank(this.recurDays)) {
              throw new Error(`recurDays is required for a ${this.recurKind} broadcast`);
            }
          }
        },
      },
    }
  );

  return Broadcast;
};
