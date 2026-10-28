const { DataTypes } = require("sequelize");

/**
 * TextOverride Model
 * Bot texts replaced from the panel, per language (specs/002-admin-panel,
 * data-model 1.6). Loaded in memory by the LanguageManager (getLang is
 * synchronous), not through settingsCache.
 */
module.exports = (sequelize) => {
  const TextOverride = sequelize.define(
    "TextOverride",
    {
      key: {
        type: DataTypes.STRING(160),
        primaryKey: true,
        allowNull: false,
        comment: "A key present in lang/en.json",
      },
      lang: {
        type: DataTypes.STRING(8),
        primaryKey: true,
        allowNull: false,
        comment: "en or fr in this feature",
      },
      text: {
        type: DataTypes.TEXT,
        allowNull: false,
        validate: { len: [1, 4000] },
        comment: "1 to 4000 characters; same {n} placeholders as the original",
      },
      originalHash: {
        type: DataTypes.STRING(16),
        allowNull: false,
        comment: "First 16 hex chars of the SHA-1 of the original file text at override time",
      },
    },
    {
      tableName: "text_overrides",
      timestamps: true,
    }
  );

  return TextOverride;
};
