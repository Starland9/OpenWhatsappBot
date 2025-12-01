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
  AUTO_STATUS_REACT: toBool(process.env.AUTO_STATUS_REACT),
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

  // Social DL Backend
  BACKEND_URL: process.env.BACKEND_URL || "https://api.socialdl.starland9.dev",

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
  LANG: (process.env.BOT_LANG || "fr").toLowerCase(),

  // TTS Config
  TTS_MAX_LENGTH: parseInt(process.env.TTS_MAX_LENGTH) || 500,

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

  // Auto Status React Configuration
  STATUS_EMOJIS: process.env.STATUS_EMOJIS || "😀,👍,❤️,🔥,💯,✨,🎉,👏,💪,🙌",

  // Auto Responder
  AUTO_RESPONDER_ENABLED: toBool(process.env.AUTO_RESPONDER_ENABLED),
  AUTO_RESPONDER_IGNORE_NUMBERS:
    process.env.AUTO_RESPONDER_IGNORE_NUMBERS || "",
  AUTO_RESPONDER_PERSONALITY:
    process.env.AUTO_RESPONDER_PERSONALITY ||
    "You are a helpful and friendly assistant. Respond naturally and conversationally.",

  // Anti-ban measures for auto responder
  AUTO_RESPONDER_MIN_DELAY:
    parseInt(process.env.AUTO_RESPONDER_MIN_DELAY) || 1000, // Min delay before response (ms)
  AUTO_RESPONDER_MAX_DELAY:
    parseInt(process.env.AUTO_RESPONDER_MAX_DELAY) || 3000, // Max delay before response (ms)
  AUTO_RESPONDER_TYPING_SPEED:
    parseInt(process.env.AUTO_RESPONDER_TYPING_SPEED) || 50, // Characters per second
  AUTO_RESPONDER_MAX_TYPING_TIME:
    parseInt(process.env.AUTO_RESPONDER_MAX_TYPING_TIME) || 10000, // Max typing indicator duration (ms)
  AUTO_RESPONDER_RATE_LIMIT:
    parseInt(process.env.AUTO_RESPONDER_RATE_LIMIT) || 5, // Max responses per time window
  AUTO_RESPONDER_RATE_WINDOW:
    parseInt(process.env.AUTO_RESPONDER_RATE_WINDOW) || 60000, // Time window for rate limit (ms)

  // Performance Optimization
  MESSAGE_CONCURRENCY_LIMIT:
    parseInt(process.env.MESSAGE_CONCURRENCY_LIMIT) || 5, // Parallel message processing limit
  CACHE_CLEANUP_INTERVAL:
    parseInt(process.env.CACHE_CLEANUP_INTERVAL) || 600000, // 10 minutes
  CACHE_MAX_AGE: parseInt(process.env.CACHE_MAX_AGE) || 3600000, // 1 hour
  CONVERSATION_UPDATE_INTERVAL:
    parseInt(process.env.CONVERSATION_UPDATE_INTERVAL) || 2000, // 2 seconds
  CONVERSATION_BATCH_SIZE: parseInt(process.env.CONVERSATION_BATCH_SIZE) || 5, // Batch size for DB updates
  MEMORY_CLEANUP_INTERVAL:
    parseInt(process.env.MEMORY_CLEANUP_INTERVAL) || 900000, // 15 minutes
  MEMORY_WARN_THRESHOLD: parseInt(process.env.MEMORY_WARN_THRESHOLD) || 400, // MB
};
