const { getLang } = require("../utils/language");
const config = require("../../config");
const pino = require("pino");

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

// Store registered commands
const commands = new Map();
const plugins = new Map(); // Store full plugin objects

/**
 * Register a command plugin
 */
function registerCommand(plugin) {
  if (!plugin.command || !plugin.execute) {
    logger.warn("Invalid plugin: missing command or execute function");
    return;
  }

  const {
    pattern,
    desc = "",
    type = "misc",
    fromMe = false,
    onlyGroup = false,
    onlyPm = false,
  } = plugin.command;

  if (!pattern) {
    logger.warn("Invalid plugin: missing pattern");
    return;
  }

  commands.set(pattern, {
    pattern,
    desc,
    type,
    fromMe,
    onlyGroup,
    onlyPm,
    execute: plugin.execute,
  });

  // Store the full plugin object for access to additional methods
  const patterns = pattern.split("|");
  patterns.forEach((p) => {
    plugins.set(p.trim(), plugin);
  });

  logger.debug(`Registered command: ${pattern}`);
}

/**
 * Execute a command if it matches
 */
async function executeCommand(message) {
  const prefix = config.PREFIX;

  // Check if message starts with prefix
  if (!message.body.startsWith(prefix)) return;

  // Extract command and args
  const [cmdText, ...args] = message.body
    .slice(prefix.length)
    .trim()
    .split(/\s+/);
  const argsString = args.join(" ");

  // Try to match command
  for (const [pattern, plugin] of commands) {
    const regex = new RegExp(`^${pattern}$`, "i");

    if (regex.test(cmdText)) {
      try {
        // Check permissions

        if (plugin.fromMe && !message.isSudo()) {
          await message.reply("❌ This command is only for sudo users");
          return;
        }

        if (plugin.onlyGroup && !message.isGroup) {
          await message.reply(getLang("extra.group_cmd"));
          return;
        }

        if (plugin.onlyPm && message.isGroup) {
          await message.reply(
            "❌ This command can only be used in private chat"
          );
          return;
        }

        if (plugin.ownerOnly && !message.isSudo()) {
          await message.reply("❌ This command is restricted to bot owners");
          return;
        }

        // Execute command
        await plugin.execute(message, argsString);
      } catch (error) {
        logger.error(`Error executing command ${pattern}:`, error);
        await message.reply(`❌ Error: ${error.message}`);
      }
      break;
    }
  }
}

/**
 * Get all registered commands
 */
function getCommands() {
  return Array.from(commands.values());
}

/**
 * Get commands by type
 */
function getCommandsByType(type) {
  return Array.from(commands.values()).filter((cmd) => cmd.type === type);
}

/**
 * Get a command by pattern
 */
function getCommandByPattern(pattern) {
  for (const [key, cmd] of commands) {
    const patterns = key.split("|");
    if (patterns.some((p) => p.toLowerCase() === pattern.toLowerCase())) {
      return cmd;
    }
  }
  return null;
}

/**
 * Get a plugin by name
 */
function getPlugin(name) {
  return plugins.get(name) || null;
}

module.exports = {
  registerCommand,
  executeCommand,
  getCommands,
  getCommandsByType,
  getCommandByPattern,
  getPlugin,
};
