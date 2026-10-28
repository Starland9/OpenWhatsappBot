const { Sequelize } = require("sequelize");
const { existsSync } = require("fs");
const path = require("path");

// Load environment variables
const configPath = path.join(__dirname, "./config.env");
const databasePath = path.join(__dirname, "./database.db");
// quiet: dotenv >= 17 prints an "injected env" line on every load.
// OWB_NO_CONFIG_ENV=1 skips the file (tests and tooling must never read the owner's secrets)
if (existsSync(configPath) && process.env.OWB_NO_CONFIG_ENV !== "1")
  require("dotenv").config({ path: configPath, quiet: true });

const DATABASE_URL = process.env.DATABASE_URL || databasePath;
// SSL is required by hosted Postgres (Heroku...); set DATABASE_SSL=false for a plain internal server
const DATABASE_SSL = process.env.DATABASE_SSL !== "false";

// Database configuration
const DATABASE = DATABASE_URL.includes("postgres")
  ? new Sequelize(DATABASE_URL, {
      dialect: "postgres",
      dialectOptions: DATABASE_SSL
        ? { ssl: { require: true, rejectUnauthorized: false } }
        : {},
      logging: false,
      pool: {
        max: 10,
        min: 2,
        acquire: 30000,
        idle: 10000,
      },
    })
  : new Sequelize({
      dialect: "sqlite",
      storage: DATABASE_URL,
      logging: false,
      pool: {
        max: 5,
        min: 1,
        acquire: 30000,
        idle: 10000,
      },
    });

// Every setting of lib/utils/settingsCatalog.js becomes an enumerable accessor: the panel override, then
// the environment / config.env, then the code default (contracts/runtime.md section 1). Types are the
// ones this file always returned (numbers, booleans, comma-joined strings for lists). Assigning
// `config.KEY = v` sets a runtime value that wins over everything (tests); nothing is persisted.
// Before settingsStore.load() runs the object behaves exactly like the old static one.
const catalog = require("./lib/utils/settingsCatalog");
const store = require("./lib/utils/settingsStore");

const config = {
  // Version
  VERSION: require("./package.json").version,

  // Database (built from process.env above, before the settings store exists)
  DATABASE,

  // Constant, no consumer
  BRANCH: "master",
};

for (const entry of catalog.entries) {
  Object.defineProperty(config, entry.configProp, {
    enumerable: true,
    configurable: true,
    get: () => store.get(entry.key),
    set: (value) => store.setRuntime(entry.key, value),
  });
}

module.exports = config;
