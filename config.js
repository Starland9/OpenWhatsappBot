const { Sequelize } = require("sequelize");
const { existsSync } = require("fs");
const path = require("path");

// Load environment variables
const configPath = path.join(__dirname, "./config.env");
const databasePath = path.join(__dirname, "./database.db");
if (existsSync(configPath)) require("dotenv").config({ path: configPath });

const toBool = (x) => x === "true";
const DATABASE_URL = process.env.DATABASE_URL || databasePath;

// Database configuration
const DATABASE = DATABASE_URL.includes("postgres")
  ? new Sequelize(DATABASE_URL, {
      dialect: "postgres",
      dialectOptions: {
        ssl: { require: true, rejectUnauthorized: false },
      },
      logging: false,
    })
  : new Sequelize({
      dialect: "sqlite",
      storage: DATABASE_URL,
      logging: false,
    });

module.exports = {
  // Version
  VERSION: require("./package.json").version,

  // Session
  SESSION_ID: (process.env.SESSION_ID || "").trim(),

  // Database
  DATABASE,

  // Bot Config
  PREFIX: process.env.PREFIX || ".",
  SUDO: process.env.SUDO || "",

  // Bot Behavior
  ALWAYS_ONLINE: toBool(process.env.ALWAYS_ONLINE),
  AUTO_READ: toBool(process.env.AUTO_READ),
  AUTO_STATUS_VIEW: toBool(process.env.AUTO_STATUS_VIEW),
  ANTI_DELETE: toBool(process.env.ANTI_DELETE),
  // Message reactions (enable/disable message reaction feature)
  ENABLE_MESSAGE_REACTIONS: toBool(process.env.ENABLE_MESSAGE_REACTIONS),

  // Sticker Config
  STICKER_PACKNAME: process.env.STICKER_PACKNAME || "Made with",
  STICKER_AUTHOR: process.env.STICKER_AUTHOR || "Bot",

  // API Keys
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || "",
  GROQ_API_KEY: process.env.GROQ_API_KEY || "",
  RMBG_KEY: process.env.RMBG_KEY || "",
  
  // New Plugin API Keys
  WEATHER_API_KEY: process.env.WEATHER_API_KEY || "",
  UNSPLASH_API_KEY: process.env.UNSPLASH_API_KEY || "",
  GIPHY_API_KEY: process.env.GIPHY_API_KEY || "",
  NEWS_API_KEY: process.env.NEWS_API_KEY || "",
  ALPHA_VANTAGE_KEY: process.env.ALPHA_VANTAGE_KEY || "",
  SPOTIFY_CLIENT_ID: process.env.SPOTIFY_CLIENT_ID || "",
  SPOTIFY_CLIENT_SECRET: process.env.SPOTIFY_CLIENT_SECRET || "",

  // Logging
  LOG_LEVEL: process.env.LOG_LEVEL || "info",
  BAILEYS_LOG_LVL: process.env.BAILEYS_LOG_LVL || "silent",

  // Heroku
  HEROKU_APP_NAME: process.env.HEROKU_APP_NAME || "",
  HEROKU_API_KEY: process.env.HEROKU_API_KEY || "",

  // Koyeb
  KOYEB: toBool(process.env.KOYEB),
  KOYEB_NAME: process.env.KOYEB_NAME || "",
  KOYEB_API: process.env.KOYEB_API || "",

  // Render
  RENDER_NAME: process.env.RENDER_NAME || "",
  RENDER_API_KEY: process.env.RENDER_API_KEY || "",

  // Language
  LANG: (process.env.LANG || "en").toLowerCase(),
  BOT_LANG: process.env.BOT_LANG || "english",

  // Group Settings
  ANTILINK_MSG:
    process.env.ANTILINK_MSG || "_Antilink Detected &mention kicked_",
  ANTIBOT_MSG: process.env.ANTIBOT_MSG || "&mention removed",
  WARN_LIMIT: parseInt(process.env.WARN_LIMIT) || 3,
  WARN_MESSAGE:
    process.env.WARN_MESSAGE ||
    "⚠️WARNING⚠️\n*User:* &mention\n*Warn:* &warn\n*Remaining:* &remaining",
  WARN_KICK_MESSAGE: process.env.WARN_KICK_MESSAGE || "&mention kicked",

  // Misc
  TIMEZONE: process.env.TIMEZONE || "UTC",
  MAX_UPLOAD: parseInt(process.env.MAX_UPLOAD) || 230,
  VPS: toBool(process.env.VPS),
  BRANCH: "master",
};
