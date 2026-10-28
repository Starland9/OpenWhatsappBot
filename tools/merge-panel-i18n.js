#!/usr/bin/env node
/**
 * Merge the panel i18n fragments into lib/admin/public/i18n/en.json and fr.json (feature 002).
 *
 * Each fragment (specs/002-admin-panel/i18n/panel-*.json) is, like the bot fragments:
 *   { "en": { "dashboard.title": "..." }, "fr": { "dashboard.title": "..." } }
 * with flat dot-path keys. The panel catalogs are FLAT maps ("nav.dashboard": "Dashboard"), sorted by
 * key when written, which keeps the diff of a merge reviewable. (The bot texts of the same feature,
 * bot-*.json, go to lang/*.json with: node tools/merge-i18n.js --frag-dir specs/002-admin-panel/i18n
 * --pattern "bot-*.json".)
 *
 * Usage:
 *   node tools/merge-panel-i18n.js [--dry-run] [--verbose]
 *                                  [--catalog-dir <dir>] [--frag-dir <dir>] [--pattern <glob>]
 *
 * --catalog-dir / --frag-dir / --pattern (or PANEL_I18N_CATALOG_DIR / PANEL_I18N_FRAG_DIR /
 * PANEL_I18N_PATTERN) point the tool at other places, e.g. copies for a dry run.
 *
 * Rules (the ones of tools/merge-i18n.js, plus the panel's named placeholders):
 *   - a fragment must have the same key set in "en" and "fr" (a missing translation is an error)
 *   - two fragments may not give the same key different values
 *   - fragment values win over the existing ones
 *   - a text and a nested key may not share a prefix ("a.b" next to "a.b.c")
 *   - en and fr must use the same {placeholders} (named or numbered) in every text
 *   - afterwards en.json and fr.json must have the same key set
 *   - nothing is written when a problem is found
 *
 * Exit code: 0 when everything is fine, 1 otherwise.
 */

const fs = require("fs");
const path = require("path");
const { loadFragments, combine, keyProblem, serialize, writeAtomic } = require("./merge-i18n");

const ROOT = path.join(__dirname, "..");
const LANGS = ["en", "fr"];
const isPlainObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    verbose: false,
    help: false,
    catalogDir: process.env.PANEL_I18N_CATALOG_DIR || path.join(ROOT, "lib", "admin", "public", "i18n"),
    fragDir: process.env.PANEL_I18N_FRAG_DIR || path.join(ROOT, "specs", "002-admin-panel", "i18n"),
    pattern: process.env.PANEL_I18N_PATTERN || "panel-*.json",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = arg.split(/=(.*)/s);
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === "--dry-run") opts.dryRun = true;
    else if (flag === "--verbose" || flag === "-v") opts.verbose = true;
    else if (flag === "--help" || flag === "-h") opts.help = true;
    else if (flag === "--catalog-dir") opts.catalogDir = path.resolve(value() || "");
    else if (flag === "--frag-dir") opts.fragDir = path.resolve(value() || "");
    else if (flag === "--pattern") opts.pattern = value() || "";
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

/** Sorted list of the placeholders of a text: named ({name}) and numbered ({0}) alike. */
function placeholders(text) {
  return (String(text).match(/\{[A-Za-z0-9_]+\}/g) || []).sort().join(",");
}

/** Flat view of a catalog that may contain nested objects. Reports non-string leaves. */
function flattenCatalog(tree, errors, label, prefix = "", out = {}) {
  for (const [key, value] of Object.entries(tree)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out[full] = value;
    else if (isPlainObject(value)) flattenCatalog(value, errors, label, full, out);
    else errors.push(`${label}: ${full} must be a string`);
  }
  return out;
}

function loadCatalog(dir, lang, errors, warnings) {
  const file = path.join(dir, `${lang}.json`);
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
  const flat = flattenCatalog(tree, errors, path.basename(file));
  if (Object.keys(flat).length !== Object.keys(tree).length) warnings.push(`${path.basename(file)} had nested keys: it will be written flat`);
  return { file, flat };
}

const sortedEntries = (flat) => Object.keys(flat).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(e.message);
    return 1;
  }
  if (opts.help) {
    console.log("Usage: node tools/merge-panel-i18n.js [--dry-run] [--verbose] [--catalog-dir <dir>] [--frag-dir <dir>] [--pattern <glob>]");
    return 0;
  }

  const errors = [];
  const warnings = [];

  let fragments = [];
  try {
    // placeholders are compared once on the merged texts below, so the loader's own check is muted
    fragments = loadFragments(opts.fragDir, errors, warnings, { pattern: opts.pattern, placeholders: () => "" });
  } catch (e) {
    errors.push(e.message);
  }
  const merged = combine(fragments, errors);

  const catalogs = {};
  for (const lang of LANGS) catalogs[lang] = loadCatalog(opts.catalogDir, lang, errors, warnings);

  const stats = {};
  const details = {};
  for (const lang of LANGS) {
    stats[lang] = { added: 0, updated: 0, unchanged: 0 };
    details[lang] = { added: [], updated: [] };
    const target = catalogs[lang];
    if (!target) continue;
    for (const [key, { value }] of merged[lang]) {
      const problem = keyProblem(key);
      if (problem) {
        errors.push(`[${lang}] "${key}": ${problem}`);
        continue;
      }
      let result;
      if (!(key in target.flat)) result = "added";
      else if (target.flat[key] === value) result = "unchanged";
      else result = "updated";
      target.flat[key] = value;
      stats[lang][result]++;
      if (result !== "unchanged") details[lang][result].push(key);
    }
  }

  if (catalogs.en && catalogs.fr) {
    const en = catalogs.en.flat;
    const fr = catalogs.fr.flat;
    for (const key of Object.keys(en)) if (!(key in fr)) errors.push(`${key} is in en.json but missing in fr.json`);
    for (const key of Object.keys(fr)) if (!(key in en)) errors.push(`${key} is in fr.json but missing in en.json`);
    for (const key of Object.keys(en)) {
      if (key in fr && placeholders(en[key]) !== placeholders(fr[key])) {
        errors.push(`${key}: placeholders differ (en ${placeholders(en[key]) || "none"} / fr ${placeholders(fr[key]) || "none"})`);
      }
    }
    for (const lang of LANGS) {
      const keys = new Set(Object.keys(catalogs[lang].flat));
      for (const key of keys) {
        const parts = key.split(".");
        for (let i = 1; i < parts.length; i++) {
          const prefix = parts.slice(0, i).join(".");
          if (keys.has(prefix)) errors.push(`${lang}.json: "${prefix}" is a text and "${key}" nests under it`);
        }
      }
    }
  }

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
    const target = catalogs[lang];
    const sorted = Object.fromEntries(sortedEntries(target.flat).map((key) => [key, target.flat[key]]));
    const text = serialize(sorted);
    if (fs.readFileSync(target.file, "utf8") === text) continue;
    writeAtomic(target.file, text);
  }
  console.log("Done.");
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main, placeholders, parseArgs };
