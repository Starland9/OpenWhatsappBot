const fs = require("fs").promises;
const path = require("path");
const registry = require("./registry");
const { languageManager } = require("../utils/language");

const logger = require("../utils/logger").createLogger("loader");

const PLUGINS_DIR = path.join(__dirname, "../../plugins");

// plugin module -> language key of its description (null: literal). A module that is already in the
// require cache (loadAll called twice) runs no getLang() again, so the first answer is kept.
const descKeys = new WeakMap();

/**
 * The language key `plugin.command.desc` was read from: the captured getLang() call whose result is the
 * description. null when the description is a literal (or composed from several keys).
 * @param {object} plugin - the required module
 * @param {Array<{ key: string, result: string }>} calls - getLang() calls made while it was required
 */
function findDescKey(plugin, calls) {
  const desc = plugin?.command?.desc;
  if (typeof desc !== "string" || desc === "") return null;
  const match = calls.find((call) => call.result === desc);
  return match ? match.key : null;
}

/**
 * Plugin loader: requires every plugins/*.js in sorted order and registers
 * commands and hooks (contracts/plugin-contract.md).
 */
class PluginLoader {
  constructor() {
    this.pluginsDir = PLUGINS_DIR;
    this.loadedPlugins = []; // file names registered (command and/or hooks)
    this.failedPlugins = []; // { file, error }
  }

  /**
   * Load all plugins from the plugins directory
   * @returns {Promise<{ loaded: string[], failed: Array<{file: string, error: string}> }>}
   */
  async loadAll(dir = this.pluginsDir) {
    let files = [];
    try {
      files = (await fs.readdir(dir))
        .filter((file) => file.endsWith(".js"))
        .sort(); // deterministic: the first registered plugin keeps a duplicate alias
    } catch (error) {
      logger.error({ err: error }, "Failed to read plugins directory");
      return { loaded: this.loadedPlugins, failed: this.failedPlugins };
    }

    for (const file of files) {
      this.loadPlugin(path.join(dir, file));
    }

    logger.info(
      `Loaded ${this.loadedPlugins.length} plugins` +
        (this.failedPlugins.length
          ? ` (${this.failedPlugins.length} failed: ${this.failedPlugins
              .map((f) => f.file)
              .join(", ")})`
          : ""),
    );
    return { loaded: this.loadedPlugins, failed: this.failedPlugins };
  }

  /**
   * Load a single plugin file. Errors are logged and the loading continues.
   * @returns {boolean} true when the module registered a command or a hook
   */
  loadPlugin(filePath) {
    const file = path.basename(filePath);
    try {
      // getLang() calls made while the module is evaluated tell which key `command.desc` came from, so
      // the registry can translate it at use time (a text override or a language change shows up at once)
      const { result: plugin, calls } = languageManager.capture(() => require(filePath));
      let descKey = findDescKey(plugin, calls);
      if (plugin && (typeof plugin === "object" || typeof plugin === "function")) {
        if (descKey || calls.length > 0 || !descKeys.has(plugin)) descKeys.set(plugin, descKey);
        else descKey = descKeys.get(plugin);
      }
      const result = registry.registerPlugin(plugin, file, { descKey });
      if (result.registered) {
        if (!this.loadedPlugins.includes(file)) this.loadedPlugins.push(file);
        logger.debug(
          `Loaded plugin: ${file}` +
            (result.hooks.length ? ` (hooks: ${result.hooks.join(", ")})` : ""),
        );
      }
      return result.registered;
    } catch (error) {
      logger.error(
        { err: error },
        `Failed to load plugin ${file}: ${error?.message}`,
      );
      this.failedPlugins = this.failedPlugins.filter((f) => f.file !== file);
      this.failedPlugins.push({ file, error: error?.message || String(error) });
      return false;
    }
  }

  /**
   * Reload all plugins (clears the registry and the require cache of plugin files)
   */
  async reload() {
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(this.pluginsDir + path.sep)) delete require.cache[key];
    }
    registry._reset();
    this.loadedPlugins = [];
    this.failedPlugins = [];
    return this.loadAll();
  }
}

module.exports = new PluginLoader();
