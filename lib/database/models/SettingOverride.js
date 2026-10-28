const { DataTypes } = require("sequelize");

/**
 * SettingOverride Model
 * A value set in the panel for an environment-backed setting; it wins over
 * config.env / the environment (specs/002-admin-panel, data-model 1.4). A
 * missing row means "use the file value, else the default".
 *
 * `value` is the raw string in the same format as the environment ("true",
 * "3", "a,b"); '' is a deliberate value (e.g. clear an API key), distinct from
 * "no row". Secrets are stored as `enc:v1:<iv>:<tag>:<ciphertext>`.
 * Writes are `UPDATE ... WHERE key = :k AND version = :v` (0 rows = conflict).
 */
module.exports = (sequelize) => {
  const SettingOverride = sequelize.define(
    "SettingOverride",
    {
      key: {
        type: DataTypes.STRING(64),
        primaryKey: true,
        allowNull: false,
        comment: "Settings catalog key (PREFIX, OPENAI_API_KEY, ALERT_UPDATE...)",
      },
      value: {
        type: DataTypes.TEXT,
        allowNull: false,
        comment: "Raw environment-format string; enc:v1:... for a secret",
      },
      version: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
        comment: "Optimistic-concurrency counter",
      },
    },
    {
      tableName: "setting_overrides",
      timestamps: true,
    }
  );

  return SettingOverride;
};
