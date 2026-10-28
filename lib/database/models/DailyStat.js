const { DataTypes } = require("sequelize");

/**
 * DailyStat Model
 * Usage counters per day (specs/002-admin-panel, data-model 1.8), written by
 * lib/utils/stats.js. The composite primary key (day, metric, subject) is the
 * upsert target of the periodic flush:
 *   INSERT ... ON CONFLICT ("day","metric","subject")
 *   DO UPDATE SET "count" = "daily_stats"."count" + excluded."count"
 * No timestamps.
 */
module.exports = (sequelize) => {
  const DailyStat = sequelize.define(
    "DailyStat",
    {
      day: {
        type: DataTypes.STRING(10),
        primaryKey: true,
        allowNull: false,
        comment: "YYYY-MM-DD in config.TIMEZONE at write time",
      },
      metric: {
        type: DataTypes.STRING(16),
        primaryKey: true,
        allowNull: false,
        comment: "messages | group_msgs | cmd_ok | cmd_fail",
      },
      subject: {
        type: DataTypes.STRING(255),
        primaryKey: true,
        allowNull: false,
        defaultValue: "",
        comment: "Command name or group JID ('' for messages)",
      },
      count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
    },
    {
      tableName: "daily_stats",
      timestamps: false,
    }
  );

  return DailyStat;
};
