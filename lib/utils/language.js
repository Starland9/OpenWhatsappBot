const fs = require("fs");
const path = require("path");
const config = require("../../config");

/**
 * Language utility for managing translations
 */
class LanguageManager {
  constructor() {
    this.currentLang = config.LANG || "en";
    this.translations = {};
    this.fallbackLang = "en";
    this.loadLanguage();
  }

  /**
   * Load the language file based on config
   */
  loadLanguage() {
    try {
      const langPath = path.join(
        __dirname,
        "../../lang",
        `${this.currentLang}.json`
      );

      if (fs.existsSync(langPath)) {
        this.translations = JSON.parse(fs.readFileSync(langPath, "utf-8"));
      } else {
        console.warn(
          `Language file not found for '${this.currentLang}', falling back to English`
        );
        this.currentLang = this.fallbackLang;
        const fallbackPath = path.join(
          __dirname,
          "../../lang",
          `${this.fallbackLang}.json`
        );
        this.translations = JSON.parse(fs.readFileSync(fallbackPath, "utf-8"));
      }
    } catch (error) {
      console.error("Error loading language file:", error);
      this.translations = {};
    }
  }

  /**
   * Get a translated string by key with placeholder replacement
   * @param {string} key - Dot notation key (e.g., "plugins.ping.desc")
   * @param {...any} args - Arguments to replace {0}, {1}, etc.
   * @returns {string} Translated string
   */
  getLang(key, ...args) {
    const keys = key.split(".");
    let value = this.translations;

    // Traverse the object using dot notation
    for (const k of keys) {
      if (value && typeof value === "object" && k in value) {
        value = value[k];
      } else {
        // If key not found, try fallback to English
        if (this.currentLang !== this.fallbackLang) {
          return this.getFallback(key, ...args);
        }
        return key; // Return the key itself if not found
      }
    }

    // If the final value is not a string, return the key
    if (typeof value !== "string") {
      return key;
    }

    // Replace placeholders {0}, {1}, etc.
    return this.replacePlaceholders(value, args);
  }

  /**
   * Get fallback translation from English
   * @param {string} key - Translation key
   * @param {...any} args - Arguments for placeholders
   * @returns {string} Fallback translation
   */
  getFallback(key, ...args) {
    try {
      const fallbackPath = path.join(
        __dirname,
        "../../lang",
        `${this.fallbackLang}.json`
      );
      const fallbackTranslations = JSON.parse(
        fs.readFileSync(fallbackPath, "utf-8")
      );

      const keys = key.split(".");
      let value = fallbackTranslations;

      for (const k of keys) {
        if (value && typeof value === "object" && k in value) {
          value = value[k];
        } else {
          return key;
        }
      }

      if (typeof value !== "string") {
        return key;
      }

      return this.replacePlaceholders(value, args);
    } catch (error) {
      return key;
    }
  }

  /**
   * Replace placeholders in a string with arguments
   * @param {string} str - String with placeholders
   * @param {Array} args - Arguments to replace
   * @returns {string} String with replaced placeholders
   */
  replacePlaceholders(str, args) {
    if (!args || args.length === 0) {
      return str;
    }

    return str.replace(/\{(\d+)\}/g, (match, index) => {
      const i = parseInt(index);
      return i < args.length && args[i] !== undefined ? args[i] : match;
    });
  }

  /**
   * Check if a key exists in translations
   * @param {string} key - Dot notation key
   * @returns {boolean} True if key exists
   */
  hasKey(key) {
    const keys = key.split(".");
    let value = this.translations;

    for (const k of keys) {
      if (value && typeof value === "object" && k in value) {
        value = value[k];
      } else {
        return false;
      }
    }

    return typeof value === "string";
  }
}

// Create singleton instance
const languageManager = new LanguageManager();

/**
 * Get translated string with placeholder replacement
 * @param {string} key - Dot notation key (e.g., "plugins.ping.desc")
 * @param {...any} args - Arguments to replace {0}, {1}, etc.
 * @returns {string} Translated string
 */
function getLang(key, ...args) {
  return languageManager.getLang(key, ...args);
}

module.exports = {
  getLang,
  languageManager,
};
