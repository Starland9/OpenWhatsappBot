"use strict";

/**
 * Persistence of the bot-text overrides (contracts/runtime.md section 4 "Persistence", data-model 1.6, FR-057 to
 * FR-060). The rules (languages, key universe, 4000 characters, `{n}` placeholders, `originalHash`) and the in-memory
 * map live in the LanguageManager (lib/utils/language.js); this module is the table `text_overrides` around them:
 *
 *   load({ models })                       async; reads the table and replaces the map of each language (boot,
 *                                          in-process restart, restore)
 *   save(lang, key, text, { actor })       validate -> upsert { key, lang, text, originalHash } -> memory
 *   clear(lang, key, { actor })            delete the row -> memory (back to the original text)
 *   list({ q, command, lang })             rows { key, group, command, placeholders, base, override, changed, originalChanged }
 *   describe(key)                          the row of one key
 *   exportRows() / importRows(rows)        backup and restore
 *
 * "Applies at the next message": the memory is replaced right after the row is written, with no TTL and no cache in
 * between, so the next `getLang` call (menu and command descriptions included, they are read lazily) returns it.
 * Errors are `TextOverrideError` (language.js): unsupported_lang, unknown_key, empty, too_long, placeholder_mismatch.
 * Nothing here logs a text: only the language, the key and the actor.
 */

const language = require("./language");

const { languageManager, OVERRIDE_LANGS } = language;

const LANGS = OVERRIDE_LANGS.slice();

let modelsRef = null;

function logger() {
  return require("./logger").createLogger("textOverrides");
}

/** `text_overrides` model: the injected one (load / tests) or the database module's */
function model(models) {
  const source = models || modelsRef || require("../database");
  return source.TextOverride || null;
}

/** Rows of a model as plain objects, whichever Sequelize shape they come in */
const plain = (row) => (row && typeof row.get === "function" ? row.get({ plain: true }) : row);

/**
 * Replace the in-memory overrides of every language by the rows of the table. A row that no longer passes the
 * validation (a key removed from lang/en.json, a placeholder that changed in the file) is skipped and logged by the
 * LanguageManager (key and code only); its row stays in the table.
 * @param {{ models?: object }} [options]
 * @returns {Promise<{ rows: number, applied: number, skipped: number }>}
 */
async function load({ models } = {}) {
  if (models) modelsRef = models;
  const TextOverride = model(models);
  if (!TextOverride) throw new Error("text_overrides table is not available");
  const rows = (await TextOverride.findAll()).map(plain);

  let applied = 0;
  let skipped = 0;
  for (const lang of LANGS) {
    const entries = new Map();
    for (const row of rows) {
      if (row.lang === lang) entries.set(row.key, { text: row.text, originalHash: row.originalHash });
    }
    // replaces the whole map of the language, an empty one included (a restore that removes every text)
    const result = languageManager.setOverrides(lang, entries);
    applied += result.applied;
    skipped += result.skipped;
  }
  return { rows: rows.length, applied, skipped };
}

/**
 * Store a replacement text. The memory changes only once the row is written.
 * @returns {Promise<{ lang: string, key: string, originalHash: string }>}
 * @throws {TextOverrideError}
 */
async function save(lang, key, text, { actor } = {}) {
  const originalHash = languageManager.validateOverride(lang, key, text); // throws before any write
  const TextOverride = model();
  if (!TextOverride) throw new Error("text_overrides table is not available");
  await TextOverride.upsert({ key, lang, text, originalHash });
  languageManager.setOverride(lang, key, text);
  logger().info({ lang, key, actor: actor || null, length: text.length }, "text override saved");
  return { lang, key, originalHash };
}

/**
 * Back to the original text. A key without override is a no-op.
 * @returns {Promise<{ lang: string, key: string, removed: boolean }>}
 */
async function clear(lang, key, { actor } = {}) {
  if (!LANGS.includes(lang)) throw new language.TextOverrideError("unsupported_lang");
  if (typeof key !== "string" || languageManager.getBase("en", key) === undefined) {
    throw new language.TextOverrideError("unknown_key");
  }
  const TextOverride = model();
  if (!TextOverride) throw new Error("text_overrides table is not available");
  const removed = (await TextOverride.destroy({ where: { key, lang } })) > 0 || Boolean(languageManager.getOverride(lang, key));
  languageManager.clearOverride(lang, key);
  if (removed) logger().info({ lang, key, actor: actor || null }, "text override cleared");
  return { lang, key, removed };
}

/** The `{n}` tokens of a text, sorted by number (duplicates kept) */
function placeholdersOf(text) {
  return (String(text === undefined || text === null ? "" : text).match(/\{\d+\}/g) || []).sort(
    (a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10),
  );
}

/**
 * Command names -> the plugin segments of the `plugins.<segment>.*` keys they own, from the registry:
 * the segment of the description key (`entry.descKey`), the file name, and the aliases themselves.
 * @returns {Map<string, { command: string, segments: Set<string> }>}
 */
function commandSegments(registry) {
  const out = new Map();
  let commands = [];
  try {
    commands = (registry || require("../plugins/registry")).getCommands();
  } catch (error) {
    commands = [];
  }
  for (const entry of commands) {
    const segments = new Set();
    if (entry.descKey) {
      const parts = String(entry.descKey).split(".");
      if (parts[0] === "plugins" && parts[1]) segments.add(parts[1]);
    }
    if (entry.file) segments.add(String(entry.file).replace(/\.js$/, ""));
    for (const alias of entry.aliases || []) segments.add(alias);
    for (const alias of entry.aliases || []) out.set(alias, { command: entry.name, segments });
  }
  return out;
}

/** The plugin segment of a key ("plugins.ping.desc" -> "ping"), or null */
const segmentOf = (key) => {
  const parts = key.split(".");
  return parts[0] === "plugins" && parts.length > 2 ? parts[1] : null;
};

/** Key without its last part ("plugins.ping.desc" -> "plugins.ping") */
const groupOf = (key) => {
  const cut = key.lastIndexOf(".");
  return cut === -1 ? key : key.slice(0, cut);
};

/** command name of each plugin segment (the first command that owns it) */
function segmentIndex(commands) {
  const out = new Map();
  for (const { command: name, segments } of commands.values()) {
    for (const segment of segments) if (!out.has(segment)) out.set(segment, name);
  }
  return out;
}

/** One row of list() for a key of lang/en.json, or null when the key is unknown */
function rowOf(key, segmentToCommand) {
  if (languageManager.getBase("en", key) === undefined) return null;
  const segment = segmentOf(key);
  const base = { en: null, fr: null };
  const override = { en: null, fr: null };
  const changed = { en: false, fr: false };
  for (const code of LANGS) {
    const original = languageManager.getBase(code, key);
    base[code] = original === undefined ? null : original;
    const own = languageManager.getOverride(code, key);
    override[code] = own ? own.text : null;
    changed[code] = own ? languageManager.isOriginalChanged(code, key) : false;
  }
  return {
    key,
    group: groupOf(key),
    command: segment ? segmentToCommand.get(segment) || null : null,
    placeholders: placeholdersOf(base.en),
    base,
    override,
    changed,
    originalChanged: LANGS.some((code) => changed[code]),
  };
}

/**
 * Every overridable key (the keys of lang/en.json) with its original and overridden texts.
 * @param {{ q?: string, command?: string, lang?: string, registry?: object }} [filters]
 *   `q`: case-insensitive substring of the key or of a text (original or replaced, both languages);
 *   `command`: a command name or alias, mapped to its keys through its plugin segment, description key or file name;
 *   `lang`: only rows that have text for this language (en or fr)
 * @returns {Array<{ key: string, group: string, command: string|null, placeholders: string[],
 *   base: { en: string|null, fr: string|null }, override: { en: string|null, fr: string|null },
 *   changed: { en: boolean, fr: boolean }, originalChanged: boolean }>}
 */
function list({ q, command, lang, registry } = {}) {
  const needle = typeof q === "string" ? q.trim().toLowerCase() : "";
  const commands = commandSegments(registry);
  const wanted = typeof command === "string" && command.trim() ? commands.get(command.trim().toLowerCase()) : null;
  // an unknown command name matches nothing (not everything)
  if (typeof command === "string" && command.trim() !== "" && !wanted) return [];
  const segmentToCommand = segmentIndex(commands);

  const rows = [];
  for (const key of languageManager.listKeys()) {
    if (wanted) {
      const segment = segmentOf(key);
      if (!(segment && wanted.segments.has(segment))) continue;
    }
    const row = rowOf(key, segmentToCommand);
    if (lang && row.base[lang] === null && row.override[lang] === null) continue;
    if (needle) {
      const haystack = [key, row.base.en, row.base.fr, row.override.en, row.override.fr]
        .filter((value) => typeof value === "string")
        .join("\n")
        .toLowerCase();
      if (!haystack.includes(needle)) continue;
    }
    rows.push(row);
  }
  return rows;
}

/** The row of one key (same shape as list()), or null when the key is not in lang/en.json */
function describe(key, { registry } = {}) {
  return rowOf(key, segmentIndex(commandSegments(registry)));
}

/**
 * Rows for a backup: `[{ key, lang, text, originalHash }]`, sorted by language then key.
 * @returns {Promise<Array<{ key: string, lang: string, text: string, originalHash: string|null }>>}
 */
async function exportRows() {
  const out = [];
  for (const lang of LANGS) {
    const keys = [...languageManager.overrides[lang].keys()].sort();
    for (const key of keys) {
      const own = languageManager.getOverride(lang, key);
      out.push({ key, lang, text: own.text, originalHash: own.originalHash });
    }
  }
  return out;
}

/**
 * Replace every override by the rows of a backup (restore). A row that fails the validation of the running
 * installation is left out and counted; the stored `originalHash` is kept so `originalChanged` still tells.
 * @param {Array<{ key: string, lang: string, text: string, originalHash?: string }>} rows
 * @returns {Promise<{ imported: number, skipped: number }>}
 */
async function importRows(rows, { models } = {}) {
  const TextOverride = model(models);
  if (!TextOverride) throw new Error("text_overrides table is not available");

  const accepted = [];
  let skipped = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    try {
      const currentHash = languageManager.validateOverride(row && row.lang, row && row.key, row && row.text);
      accepted.push({
        key: row.key,
        lang: row.lang,
        text: row.text,
        originalHash: typeof row.originalHash === "string" && row.originalHash ? row.originalHash.slice(0, 16) : currentHash,
      });
    } catch (error) {
      if (!(error instanceof language.TextOverrideError)) throw error;
      skipped += 1;
    }
  }

  await TextOverride.sequelize.transaction(async (transaction) => {
    await TextOverride.destroy({ where: {}, transaction });
    if (accepted.length) await TextOverride.bulkCreate(accepted, { transaction });
  });

  for (const lang of LANGS) {
    const entries = new Map();
    for (const row of accepted) if (row.lang === lang) entries.set(row.key, { text: row.text, originalHash: row.originalHash });
    languageManager.setOverrides(lang, entries);
  }
  return { imported: accepted.length, skipped };
}

module.exports = { load, save, clear, list, describe, exportRows, importRows, placeholdersOf, commandSegments, LANGS };
