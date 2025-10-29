const fs = require("fs").promises;
const path = require("path");
const { registerCommand } = require("./registry");
const pino = require("pino");

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

/**
 * Plugin loader for dynamic plugin loading
 */
class PluginLoader {
  constructor() {
    this.loadedPlugins = [];
  }

  /**
   * Load all plugins from the plugins directory
   */
  async loadAll() {
    const pluginsDir = path.join(__dirname, "../../plugins");

    try {
      const files = await fs.readdir(pluginsDir);

      for (const file of files) {
        if (file.endsWith(".js")) {
          await this.loadPlugin(path.join(pluginsDir, file));
        }
      }

      logger.info(`Loaded ${this.loadedPlugins.length} plugins`);
    } catch (error) {
      logger.error("Failed to load plugins:", error);
    }
  }

  /**
   * Load a single plugin file
   */
  async loadPlugin(filePath) {
    try {
      // Clear require cache for hot reload
      delete require.cache[require.resolve(filePath)];

      const plugin = require(filePath);

      if (plugin && plugin.command) {
        registerCommand(plugin);
        this.loadedPlugins.push(path.basename(filePath));
        logger.debug(`Loaded plugin: ${path.basename(filePath)}`);
      }
    } catch (error) {
      logger.error(`Failed to load plugin ${filePath}:`, error);
    }
  }

  /**
   * Reload all plugins
   */
  async reload() {
    this.loadedPlugins = [];
    await this.loadAll();
  }
}

module.exports = new PluginLoader();
