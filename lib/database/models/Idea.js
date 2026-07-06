const { DataTypes } = require("sequelize");

/**
 * Idea Model - group idea / suggestion box
 */
module.exports = (sequelize) => {
  const Idea = sequelize.define(
    "Idea",
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      groupJid: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      authorJid: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      text: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      category: {
        type: DataTypes.STRING,
        defaultValue: "general",
      },
      voters: {
        type: DataTypes.TEXT,
        defaultValue: "",
        get() {
          const raw = this.getDataValue("voters");
          return raw ? raw.split(",").filter(Boolean) : [];
        },
        set(val) {
          this.setDataValue(
            "voters",
            Array.isArray(val) ? val.join(",") : val || "",
          );
        },
      },
    },
    {
      tableName: "ideas",
      timestamps: true,
      indexes: [{ fields: ["groupJid", "createdAt"] }],
    },
  );

  return Idea;
};
