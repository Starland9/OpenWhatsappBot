"use strict";
/**
 * Bot-text fragments of feature 002 (specs/002-admin-panel/i18n/bot-*.json) applied to the language manager, for
 * the tests that run before W2-A merges them into lang/{en,fr}.json (applying them again afterwards is harmless).
 *
 *   require("./helpers/botFragments").applyBotFragments();
 *   node --require ./test/helpers/botFragments.js tools/admin-reset.js     (a child process: preload + OWB_APPLY_BOT_FRAGMENTS=1)
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");

function applyBotFragments() {
  const { languageManager } = require(path.join(ROOT, "lib", "utils", "language"));
  const dir = path.join(ROOT, "specs", "002-admin-panel", "i18n");
  const lang = String(languageManager.currentLang || "en").substring(0, 2);
  let applied = 0;
  for (const file of fs.readdirSync(dir).filter((name) => /^bot-.+\.json$/.test(name))) {
    const fragment = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    for (const [key, value] of Object.entries(fragment[lang] || fragment.en || {})) {
      const parts = key.split(".");
      let node = languageManager.translations;
      for (const part of parts.slice(0, -1)) {
        if (typeof node[part] !== "object" || node[part] === null) node[part] = {};
        node = node[part];
      }
      node[parts[parts.length - 1]] = value;
      applied += 1;
    }
  }
  return applied;
}

if (process.env.OWB_APPLY_BOT_FRAGMENTS === "1") applyBotFragments();

module.exports = { applyBotFragments };
