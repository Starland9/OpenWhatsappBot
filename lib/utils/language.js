const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const config = require("../../config");

/** Languages whose texts the panel may override (contracts/runtime.md section 4) */
const OVERRIDE_LANGS = ["en", "fr"];
/** Longest override text, in characters */
const MAX_OVERRIDE_LENGTH = 4000;
const PLACEHOLDER_RE = /\{\d+\}/g;

/**
 * Why a text override was refused. `code` is stable and snake_case; `params` carries the details
 * (`placeholder_mismatch`: `params.expected` = the tokens of the original text). The message is for
 * logs only and never contains the submitted text.
 *
 * Codes: unsupported_lang, unknown_key, empty, too_long, placeholder_mismatch
 */
class TextOverrideError extends Error {
  constructor(code, params) {
    super(`text override refused: ${code}`);
    this.name = "TextOverrideError";
    this.code = code;
    if (params) this.params = params;
  }
}

/** Dotted-key lookup in a nested translations object; undefined unless it ends on a string. */
function lookup(tree, key) {
  let value = tree;
  for (const part of key.split(".")) {
    if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, part)) {
      value = value[part];
    } else {
      return undefined;
    }
  }
  return typeof value === "string" ? value : undefined;
}

/** Flat dotted keys of every string leaf of a nested translations object */
function flatKeys(tree, prefix = "", out = []) {
  for (const [name, value] of Object.entries(tree || {})) {
    const full = prefix ? `${prefix}.${name}` : name;
    if (typeof value === "string") out.push(full);
    else if (value && typeof value === "object" && !Array.isArray(value)) flatKeys(value, full, out);
  }
  return out;
}

/** The `{n}` tokens of a text, sorted by number (duplicates kept: it is a multiset) */
function placeholdersOf(text) {
  return (String(text).match(PLACEHOLDER_RE) || []).sort(
    (a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10)
  );
}

/** One log line without throwing; the logger is loaded lazily (this module sits below it) */
function logWarn(fields, message) {
  try {
    require("./logger").createLogger("language").warn(fields, message);
  } catch (error) {
    console.warn(message, JSON.stringify(fields));
  }
}

/**
 * Language utility for managing translations
 */
class LanguageManager {
  /**
   * @param {Object} [options]
   * @param {string} [options.langDir] - Folder of the <lang>.json files (default: ../../lang)
   * @param {{ LANG?: string }} [options.config] - Where reload() reads LANG (default: config.js)
   */
  constructor({ langDir, config: source } = {}) {
    this.langDir = langDir || path.join(__dirname, "../../lang");
    this.configSource = source || config;
    this.currentLang = this.configSource.LANG || "en";
    this.translations = {};
    this.fallbackLang = "en";
    /** @type {Object<string, Object|null>} parsed language files, read once per reload() */
    this.files = {};
    /** @type {Object<string, Map<string, {text: string, originalHash: string|null}>>} */
    this.overrides = { en: new Map(), fr: new Map() };
    /** @type {Array<Array<{key: string, result: string}>>} active capture() recorders */
    this.captures = [];
    this.loadLanguage();
  }

  /**
   * Parsed content of <langDir>/<code>.json, read at most once until reload().
   * @param {string} code - Two-letter language code
   * @returns {Object|null} null when the file is missing or invalid
   */
  readFile(code) {
    if (!/^[a-z]{2}$/i.test(code)) return null;
    if (!(code in this.files)) {
      const file = path.join(this.langDir, `${code}.json`);
      try {
        this.files[code] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf-8")) : null;
      } catch (error) {
        console.error("Error loading language file:", error);
        this.files[code] = null;
      }
    }
    return this.files[code];
  }

  /**
   * Load the language file based on config
   */
  loadLanguage() {
    try {
      const translations = this.readFile(this.currentLang.substring(0, 2));
      if (translations) {
        this.translations = translations;
      } else {
        console.warn(
          `Language file not found for '${this.currentLang}', falling back to English`
        );
        this.currentLang = this.fallbackLang;
        this.translations = this.readFile(this.fallbackLang) || {};
      }
    } catch (error) {
      console.error("Error loading language file:", error);
      this.translations = {};
    }
  }

  /**
   * Re-read `config.LANG` and the language files from disk. Overrides are kept.
   */
  reload() {
    this.files = {};
    this.currentLang = String(this.configSource.LANG || "en");
    this.translations = {};
    this.loadLanguage();
  }

  /** Log a warning (replaceable in tests) */
  warn(fields, message) {
    logWarn(fields, message);
  }

  /** Two-letter code of the active language (the key of its override map) */
  activeCode() {
    return String(this.currentLang || this.fallbackLang).substring(0, 2);
  }

  /**
   * Resolve a key without placeholders:
   * overrides[currentLang] -> translations -> overrides.en -> en.json -> undefined
   */
  resolve(key) {
    const code = this.activeCode();
    const own = this.overrides[code] && this.overrides[code].get(key);
    if (own) return own.text;

    const value = lookup(this.translations, key);
    if (value !== undefined) return value;

    if (code !== this.fallbackLang) return this.resolveFallback(key);
    return undefined;
  }

  /** Fallback tiers only: overrides.en -> en.json -> undefined */
  resolveFallback(key) {
    const own = this.overrides[this.fallbackLang].get(key);
    if (own) return own.text;
    return lookup(this.readFile(this.fallbackLang), key);
  }

  /**
   * Get a translated string by key with placeholder replacement
   * @param {string} key - Dot notation key (e.g., "plugins.ping.desc")
   * @param {...any} args - Arguments to replace {0}, {1}, etc.
   * @returns {string} Translated string
   */
  getLang(key, ...args) {
    const text = this.resolve(key);
    // A missing key returns the key itself
    const result = text === undefined ? key : this.replacePlaceholders(text, args);
    for (const calls of this.captures) calls.push({ key, result });
    return result;
  }

  /**
   * Get fallback translation from English (read once, not on every miss)
   * @param {string} key - Translation key
   * @param {...any} args - Arguments for placeholders
   * @returns {string} Fallback translation
   */
  getFallback(key, ...args) {
    const text = this.resolveFallback(key);
    return text === undefined ? key : this.replacePlaceholders(text, args);
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
    return lookup(this.translations, key) !== undefined;
  }

  // -------------------------------------------------------------------------
  // Text overrides (set from the admin panel; contracts/runtime.md section 4)
  // -------------------------------------------------------------------------

  /**
   * Text of lang/<lang>.json for a key, ignoring overrides.
   * @returns {string|undefined}
   */
  getBase(lang, key) {
    if (typeof lang !== "string" || typeof key !== "string") return undefined;
    return lookup(this.readFile(lang), key);
  }

  /** Override if any, else the base text */
  getEffective(lang, key) {
    const own = this.overrides[lang] && this.overrides[lang].get(key);
    return own ? own.text : this.getBase(lang, key);
  }

  /** @returns {{ text: string, originalHash: string|null }|undefined} */
  getOverride(lang, key) {
    const own = this.overrides[lang] && this.overrides[lang].get(key);
    return own ? { text: own.text, originalHash: own.originalHash } : undefined;
  }

  /**
   * sha1 of the base text as hex, first 16 characters (null when the language file lacks the key).
   * Stored with an override to tell later that the original text changed.
   */
  originalHash(lang, key) {
    const base = this.getBase(lang, key);
    if (base === undefined) return null;
    return crypto.createHash("sha1").update(base).digest("hex").slice(0, 16);
  }

  /** The base text changed since the override was saved (false when there is no override) */
  isOriginalChanged(lang, key) {
    const own = this.overrides[lang] && this.overrides[lang].get(key);
    return own ? own.originalHash !== this.originalHash(lang, key) : false;
  }

  /** Flat keys of lang/en.json: the universe of overridable texts */
  listKeys() {
    return flatKeys(this.readFile("en"));
  }

  /**
   * Check an override and return the hash of the original it replaces.
   * @throws {TextOverrideError}
   */
  validateOverride(lang, key, text) {
    if (!OVERRIDE_LANGS.includes(lang)) throw new TextOverrideError("unsupported_lang");
    if (typeof key !== "string" || this.getBase("en", key) === undefined) {
      throw new TextOverrideError("unknown_key");
    }
    if (typeof text !== "string" || text.trim() === "") throw new TextOverrideError("empty");
    // length counts UTF-16 units: only count code points when it could matter
    if (text.length > MAX_OVERRIDE_LENGTH && Array.from(text).length > MAX_OVERRIDE_LENGTH) {
      throw new TextOverrideError("too_long");
    }

    const base = this.getBase(lang, key);
    const expected = placeholdersOf(base !== undefined ? base : this.getBase("en", key));
    const found = placeholdersOf(text);
    if (expected.join(",") !== found.join(",")) {
      throw new TextOverrideError("placeholder_mismatch", { expected });
    }
    return this.originalHash(lang, key);
  }

  /**
   * Replace one text now (the next message uses it).
   * @returns {{ originalHash: string|null }}
   * @throws {TextOverrideError}
   */
  setOverride(lang, key, text) {
    const originalHash = this.validateOverride(lang, key, text);
    this.overrides[lang].set(key, { text, originalHash });
    return { originalHash };
  }

  /** Remove one override (no-op when there is none) */
  clearOverride(lang, key) {
    if (this.overrides[lang]) this.overrides[lang].delete(key);
  }

  /**
   * Replace every override of a language at once (boot, restore). Same validation as setOverride;
   * an invalid entry is skipped and logged (key and code only). A value is the text, or
   * `{ text, originalHash }` to keep the hash that was stored with it.
   * @param {string} lang
   * @param {Map<string, string|{text: string, originalHash?: string}>|Object} entries
   * @returns {{ applied: number, skipped: number }}
   * @throws {TextOverrideError} unsupported_lang
   */
  setOverrides(lang, entries) {
    if (!OVERRIDE_LANGS.includes(lang)) throw new TextOverrideError("unsupported_lang");
    const pairs = entries instanceof Map ? [...entries] : Object.entries(entries || {});
    const next = new Map();
    let skipped = 0;
    for (const [key, value] of pairs) {
      const text = value && typeof value === "object" ? value.text : value;
      try {
        const currentHash = this.validateOverride(lang, key, text);
        const stored = value && typeof value === "object" && typeof value.originalHash === "string";
        next.set(key, { text, originalHash: stored ? value.originalHash : currentHash });
      } catch (error) {
        if (!(error instanceof TextOverrideError)) throw error;
        skipped++;
        this.warn({ lang, key: String(key), code: error.code }, "text override skipped");
      }
    }
    // the map is replaced in one assignment: a message in flight sees the old or the new set
    this.overrides[lang] = next;
    return { applied: next.size, skipped };
  }

  /**
   * Run `fn` and record every getLang call it makes synchronously.
   * Used by the plugin loader to find the key behind `command.desc`.
   * @template T
   * @param {() => T} fn
   * @returns {{ result: T, calls: Array<{ key: string, result: string }> }}
   */
  capture(fn) {
    const calls = [];
    this.captures.push(calls);
    try {
      return { result: fn(), calls };
    } finally {
      const index = this.captures.lastIndexOf(calls);
      if (index !== -1) this.captures.splice(index, 1);
    }
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
  LanguageManager,
  TextOverrideError,
  OVERRIDE_LANGS,
  MAX_OVERRIDE_LENGTH,
};
