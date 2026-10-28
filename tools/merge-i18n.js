#!/usr/bin/env node
/**
 * Merge the i18n fragments into lang/en.json and lang/fr.json.
 *
 * Each fragment (specs/001-audit-fix-commands/i18n/*.json) is:
 *   { "en": { "plugins.kick.usage": "..." }, "fr": { "plugins.kick.usage": "..." } }
 * with flat dot-path keys.
 *
 * Usage:
 *   node tools/merge-i18n.js [--dry-run] [--verbose]
 *                            [--lang-dir <dir>] [--frag-dir <dir>] [--pattern <glob>]
 *
 * --lang-dir / --frag-dir (or the I18N_LANG_DIR / I18N_FRAG_DIR environment variables)
 * point the tool at other directories, e.g. copies for a dry run.
 *
 * --pattern (or I18N_FRAG_PATTERN) restricts the fragment files to a glob on the file name
 * (`*` and `?` only; default "*.json", so the 001 behaviour is unchanged). Feature 002 merges its
 * bot texts with: --frag-dir specs/002-admin-panel/i18n --pattern "bot-*.json"
 *
 * Rules:
 *   - a fragment must have the same key set in "en" and "fr"
 *   - two fragments may not give the same key different values
 *   - fragment values win over the existing ones; new keys go at the end of their object
 *   - a string is never turned into an object, nor an object into a string
 *   - afterwards lang/en.json and lang/fr.json must have the same flat key set
 *   - nothing is written when a problem is found
 *
 * Exit code: 0 when everything is fine, 1 otherwise.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const LANGS = ["en", "fr"];
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const isPlainObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    verbose: false,
    help: false,
    langDir: process.env.I18N_LANG_DIR || path.join(ROOT, "lang"),
    fragDir: process.env.I18N_FRAG_DIR || path.join(ROOT, "specs", "001-audit-fix-commands", "i18n"),
    pattern: process.env.I18N_FRAG_PATTERN || "*.json",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = arg.split(/=(.*)/s);
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === "--dry-run") opts.dryRun = true;
    else if (flag === "--verbose" || flag === "-v") opts.verbose = true;
    else if (flag === "--help" || flag === "-h") opts.help = true;
    else if (flag === "--lang-dir") opts.langDir = path.resolve(value() || "");
    else if (flag === "--frag-dir") opts.fragDir = path.resolve(value() || "");
    else if (flag === "--pattern") opts.pattern = value() || "";
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

/**
 * RegExp for a file-name glob: `*` matches any run of characters, `?` one character, everything else
 * is literal. A glob with a path separator is refused (patterns select files of one directory).
 */
function globToRegExp(glob) {
  if (typeof glob !== "string" || !glob) throw new Error("--pattern needs a glob such as \"bot-*.json\"");
  if (/[\\/]/.test(glob)) throw new Error(`--pattern "${glob}" must be a file name glob, not a path`);
  const source = glob
    .split("")
    .map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${source}$`);
}

/** Why a flat key is not acceptable, or null */
function keyProblem(key) {
  if (typeof key !== "string" || !key) return "empty key";
  const segments = key.split(".");
  if (segments.some((s) => !s)) return "empty segment (leading, trailing or double dot)";
  const bad = segments.find((s) => FORBIDDEN_SEGMENTS.has(s));
  if (bad) return `forbidden segment "${bad}"`;
  return null;
}

/** Sorted list of the placeholders ({0}, {1}...) used by a text */
function placeholders(text) {
  return (String(text).match(/\{\d+\}/g) || []).sort().join(",");
}

/**
 * Read and check every fragment. Returns [{ file, data }] in file name order.
 * options.pattern: glob on the file name (default "*.json"); options.placeholders: function giving the
 * comparable placeholder signature of a text (default: numeric `{0}`, `{1}`).
 */
function loadFragments(fragDir, errors, warnings, options = {}) {
  const matcher = globToRegExp(options.pattern || "*.json");
  const signature = options.placeholders || placeholders;
  if (!fs.existsSync(fragDir)) {
    errors.push(`Fragment directory not found: ${fragDir}`);
    return [];
  }
  const files = fs
    .readdirSync(fragDir)
    .filter((f) => f.endsWith(".json") && matcher.test(f))
    .sort();

  const fragments = [];
  for (const file of files) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(fragDir, file), "utf8"));
    } catch (e) {
      errors.push(`${file}: invalid JSON (${e.message})`);
      continue;
    }
    if (!isPlainObject(data)) {
      errors.push(`${file}: the top level must be an object with "en" and "fr"`);
      continue;
    }

    let valid = true;
    for (const lang of Object.keys(data)) {
      if (!LANGS.includes(lang)) {
        errors.push(`${file}: unknown language section "${lang}" (expected: ${LANGS.join(", ")})`);
        valid = false;
      }
    }
    for (const lang of LANGS) {
      if (!isPlainObject(data[lang])) {
        errors.push(`${file}: missing or invalid "${lang}" section`);
        valid = false;
      }
    }
    if (!valid) continue;

    for (const lang of LANGS) {
      for (const [key, value] of Object.entries(data[lang])) {
        const problem = keyProblem(key);
        if (problem) {
          errors.push(`${file} [${lang}] "${key}": ${problem}`);
          valid = false;
        } else if (typeof value !== "string") {
          errors.push(`${file} [${lang}] ${key}: the value must be a string`);
          valid = false;
        } else if (value === "") {
          warnings.push(`${file} [${lang}] ${key}: empty text`);
        }
      }
    }
    if (!valid) continue;

    // Same key set in both languages
    const [a, b] = LANGS;
    for (const key of Object.keys(data[a])) {
      if (!has(data[b], key)) {
        errors.push(`${file}: ${key} is in "${a}" but missing in "${b}"`);
        valid = false;
      }
    }
    for (const key of Object.keys(data[b])) {
      if (!has(data[a], key)) {
        errors.push(`${file}: ${key} is in "${b}" but missing in "${a}"`);
        valid = false;
      }
    }
    for (const key of Object.keys(data[a])) {
      if (has(data[b], key) && signature(data[a][key]) !== signature(data[b][key])) {
        warnings.push(`${file}: ${key} uses different placeholders in en and fr`);
      }
    }

    // A fragment with a missing translation is reported but not merged
    if (!valid) continue;

    fragments.push({ file, data });
  }
  return fragments;
}

/**
 * Combine the fragments: per language, a Map key -> { value, file }.
 * The same key with different values in two fragments is a conflict.
 */
function combine(fragments, errors) {
  const merged = { en: new Map(), fr: new Map() };
  for (const { file, data } of fragments) {
    for (const lang of LANGS) {
      for (const [key, value] of Object.entries(data[lang])) {
        const previous = merged[lang].get(key);
        if (previous && previous.value !== value) {
          errors.push(
            `conflict [${lang}] ${key}: ${JSON.stringify(previous.value)} (${previous.file}) vs ${JSON.stringify(value)} (${file})`
          );
        } else if (!previous) {
          merged[lang].set(key, { value, file });
        }
      }
    }
  }
  return merged;
}

function loadLang(langDir, lang, errors) {
  const file = path.join(langDir, `${lang}.json`);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    errors.push(`${file}: cannot read (${e.message})`);
    return null;
  }
  let tree;
  try {
    tree = JSON.parse(text);
  } catch (e) {
    errors.push(`${file}: invalid JSON (${e.message})`);
    return null;
  }
  if (!isPlainObject(tree)) {
    errors.push(`${file}: the top level must be an object`);
    return null;
  }
  return { file, text, tree };
}

/**
 * Set a flat dot-key into a nested object.
 * @returns {"added"|"updated"|"unchanged"}
 * @throws {Error} when it would turn a string into an object or the reverse
 */
function deepSet(tree, key, value) {
  const segments = key.split(".");
  let node = tree;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    if (!has(node, segment)) {
      node[segment] = {};
    } else if (!isPlainObject(node[segment])) {
      const trail = segments.slice(0, i + 1).join(".");
      throw new Error(`${trail} is ${Array.isArray(node[segment]) ? "an array" : "a string"}, it cannot become an object`);
    }
    node = node[segment];
  }

  const leaf = segments[segments.length - 1];
  if (!has(node, leaf)) {
    node[leaf] = value;
    return "added";
  }
  if (typeof node[leaf] !== "string") {
    throw new Error(`${key} is ${isPlainObject(node[leaf]) ? "an object" : "an array"}, it cannot become a string`);
  }
  if (node[leaf] === value) return "unchanged";
  node[leaf] = value;
  return "updated";
}

/** Set of the flat keys of a tree (strings, arrays and other values are leaves) */
function flatten(tree, prefix = "", out = new Set()) {
  for (const [key, value] of Object.entries(tree)) {
    if (isPlainObject(value)) flatten(value, `${prefix}${key}.`, out);
    else out.add(`${prefix}${key}`);
  }
  return out;
}

function serialize(tree) {
  return `${JSON.stringify(tree, null, 2)}\n`;
}

/** Write through a temporary file so that a reader never sees half a file */
function writeAtomic(file, content) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(e.message);
    return 1;
  }
  if (opts.help) {
    console.log(
      "Usage: node tools/merge-i18n.js [--dry-run] [--verbose] [--lang-dir <dir>] [--frag-dir <dir>] [--pattern <glob>]"
    );
    return 0;
  }

  const errors = [];
  const warnings = [];

  let fragments = [];
  try {
    fragments = loadFragments(opts.fragDir, errors, warnings, { pattern: opts.pattern });
  } catch (e) {
    errors.push(e.message);
  }
  const merged = combine(fragments, errors);

  const langs = {};
  for (const lang of LANGS) langs[lang] = loadLang(opts.langDir, lang, errors);

  const stats = {};
  const details = {};
  for (const lang of LANGS) {
    stats[lang] = { added: 0, updated: 0, unchanged: 0 };
    details[lang] = { added: [], updated: [] };
    const target = langs[lang];
    if (!target) continue;

    if (serialize(target.tree) !== target.text) {
      warnings.push(`${path.basename(target.file)} is not in the canonical format (2 spaces + newline): it will be normalized on the next write`);
    }

    for (const [key, { value }] of merged[lang]) {
      try {
        const result = deepSet(target.tree, key, value);
        stats[lang][result]++;
        if (result !== "unchanged") details[lang][result].push(key);
      } catch (e) {
        errors.push(`${lang}.json: ${e.message}`);
      }
    }
  }

  // en and fr must expose the same keys once merged
  if (langs.en && langs.fr) {
    const en = flatten(langs.en.tree);
    const fr = flatten(langs.fr.tree);
    const onlyEn = [...en].filter((k) => !fr.has(k));
    const onlyFr = [...fr].filter((k) => !en.has(k));
    for (const key of onlyEn) errors.push(`${key} is in en.json but missing in fr.json`);
    for (const key of onlyFr) errors.push(`${key} is in fr.json but missing in en.json`);
  }

  // Report
  console.log(`Fragments: ${fragments.length}${fragments.length ? ` (${fragments.map((f) => f.file).join(", ")})` : ""}`);
  for (const lang of LANGS) {
    const s = stats[lang];
    console.log(`${lang}.json: ${s.added} added, ${s.updated} updated, ${s.unchanged} unchanged`);
    if (opts.verbose) {
      for (const key of details[lang].added) console.log(`  + ${key}`);
      for (const key of details[lang].updated) console.log(`  ~ ${key}`);
    }
  }
  for (const warning of warnings) console.warn(`warning: ${warning}`);

  if (errors.length) {
    console.error(`\n${errors.length} problem(s), nothing written:`);
    for (const error of errors) console.error(`  - ${error}`);
    return 1;
  }

  if (opts.dryRun) {
    console.log("Dry run: nothing written.");
    return 0;
  }

  for (const lang of LANGS) {
    const s = stats[lang];
    if (s.added + s.updated === 0) continue;
    writeAtomic(langs[lang].file, serialize(langs[lang].tree));
  }
  console.log("Done.");
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main, deepSet, flatten, keyProblem, loadFragments, combine, globToRegExp, placeholders, serialize, writeAtomic };
